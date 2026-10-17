use crate::app_activity::{begin_server_activity, end_server_activity};
use crate::database::{
    get_ai_response_by_id, images_fingerprint, insert_ai_response, query_database_candidates,
    query_database_exact,
    set_question_pending_correction, QuestionMatch,
};
use crate::types::{
    ModelCallProgressRequest, ModelCallResponseRequest, QueryData, QueryRequest, QueryResponse,
    ServerInfo, ServerState,
};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio_stream::wrappers::BroadcastStream;
use uuid;
use warp::http::HeaderMap;
use warp::Filter;

const QUERY_TEST_PAGE_HTML: &str = include_str!("query_test_page.html");

fn read_app_config() -> serde_json::Value {
    crate::storage::read_config_file("config.json")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 关闭主窗口时是隐藏到系统托盘（true，默认）还是直接退出（false）。
/// 服务要在后台持续给 OCS 答题，所以默认保留；用户可在「常规设置」里改。
fn close_to_tray_from_config(config: &serde_json::Value) -> bool {
    config.get("closeToTray").and_then(|v| v.as_bool()).unwrap_or(true)
}

pub(crate) fn close_to_tray_enabled() -> bool {
    close_to_tray_from_config(&read_app_config())
}

/// 是否将 AI 回答写入本地题库（读取 config.json 的 autoAddToQuestionBank）
fn should_auto_add_to_question_bank() -> bool {
    read_app_config()
        .get("autoAddToQuestionBank")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 从设置计算模型等待预算：(静默超时秒, 绝对上限秒)
/// - inactivity：无新进度多久判超时（≈ 单次最长响应 + 余量）
/// - absolute：整段等待硬上限（覆盖重试，且不受 keepalive 续命）
fn model_wait_budget_secs(has_url: bool) -> (u64, u64) {
    let cfg = read_app_config();
    model_wait_budget_from_config(&cfg, has_url)
}

fn model_wait_budget_from_config(cfg: &serde_json::Value, has_url: bool) -> (u64, u64) {
    let timeout = cfg
        .get("modelResponseTimeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(40)
        .clamp(5, 600);
    let retries = cfg
        .get("modelRetryCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(2)
        .min(10);
    let search_timeout = cfg.get("webSearch")
        .filter(|search| search.get("enabled").and_then(|v| v.as_bool()) == Some(true))
        .map(|search| search.get("timeoutSec").and_then(|v| v.as_u64()).unwrap_or(20).clamp(3, 120))
        .unwrap_or(0);
    let inactivity = timeout.max(search_timeout).saturating_add(20).max(30);
    // 答题和总结顺序执行，各自可重试；附件读取另有一个单次超时。
    let absolute = timeout
        .saturating_mul(2 * (retries + 1) + 1)
        .saturating_add(search_timeout)
        .saturating_add(2 * retries * 2) // 两阶段的重试退避，每次最多 2 秒
        .saturating_add(if has_url { 90 } else { 60 })
        .max(inactivity);
    (inactivity, absolute)
}

/// 验证管理员 token（从 Authorization: Bearer <token> 或直接值中提取）
fn check_admin_token(auth: &Option<String>) -> bool {
    let token = match auth {
        None => return false,
        Some(v) => {
            let v = v.trim();
            if v.to_lowercase().starts_with("bearer ") {
                v[7..].trim().to_string()
            } else {
                v.to_string()
            }
        }
    };
    if token.is_empty() {
        return false;
    }
    let config = read_app_config();
    let admin_token = config
        .get("adminToken")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    !admin_token.is_empty() && token == admin_token
}

/// 没有任何题目内容（题目为空白、也没有图片）。
/// OCS 检测题库是否可用时会先 HEAD 题库地址，失败后再发一个不带任何参数的 GET：
/// 这种请求不是真正的题目，不能转给 AI，更不能把结果存进题库。
fn is_blank_question(title: &str, images: &[String]) -> bool {
    title.trim().is_empty() && images.iter().all(|image| image.trim().is_empty())
}

/// OCS 的「题库连接状态」探测：HEAD /query?t=...，只要返回 2xx/3xx 就算可用。
/// 不记录日志、不查库、不调用模型。
fn query_head_route() -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    warp::path("query").and(warp::head()).map(warp::reply)
}

/// 按字符数（而非字节数）截断，避免在多字节字符（如中文）中间切开导致 panic
fn truncate_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

/// 检测文本中是否包含URL
fn contains_url(text: &str) -> bool {
    static URL_REGEX: OnceLock<Regex> = OnceLock::new();
    URL_REGEX
        .get_or_init(|| Regex::new(r"https?://[^\s]+").unwrap())
        .is_match(text)
}

fn resolve_request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("127.0.0.1:3000");
    format!("http://{}", host)
}

/// 请求日志里的请求体：把体积很大的 data URL 图片换成占位说明，
/// 否则一张图就是几百 KB 到几 MB，会被写进请求日志和 SSE 推送并长期占用内存。
fn request_body_for_log(request: &QueryRequest) -> String {
    let mut value = serde_json::to_value(request).unwrap_or_default();
    if let Some(images) = value.get_mut("images").and_then(|v| v.as_array_mut()) {
        for image in images.iter_mut() {
            if let Some(text) = image.as_str() {
                if text.starts_with("data:") && text.len() > 256 {
                    let mime = text[5..].split([';', ',']).next().unwrap_or("image");
                    *image = Value::String(format!("[{} data URL, {} 字节已省略]", mime, text.len()));
                }
            }
        }
    }
    value.to_string()
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn build_pending_correction_button(origin: &str, question_id: i64, is_pending_correction: bool) -> String {
    if question_id <= 0 {
        return String::new();
    }

    if is_pending_correction {
        return "<button type=\"button\" disabled style=\"padding:4px 10px;border:none;border-radius:999px;background:#f59e0b;color:#fff;font-size:12px;cursor:not-allowed;opacity:0.75;white-space:nowrap;\">已标记待修正</button>".to_string();
    }

    let url = format!("{}/api/questions/{}/pending-correction", origin, question_id);
    format!(
        r#"<button type="button" style="padding:4px 10px;border:none;border-radius:999px;background:#ef4444;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;" onclick="(async()=>{{const btn=this;if(btn.dataset.loading==='1')return;const text=btn.textContent||'标记为待修正';btn.dataset.loading='1';btn.disabled=true;btn.textContent='标记中...';try{{const res=await fetch('{url}',{{method:'POST'}});const data=await res.json().catch(()=>({{success:false,message:'标记失败'}}));if(!res.ok||!data.success)throw new Error(data.message||'标记失败');btn.textContent='已标记待修正';btn.style.opacity='0.75';btn.style.cursor='not-allowed';}}catch(error){{btn.disabled=false;btn.textContent=text;alert(error&&error.message?error.message:'标记失败');}}finally{{delete btn.dataset.loading;}}}})()">标记为待修正</button>"#,
        url = url
    )
}

fn build_query_data(
    origin: &str,
    question_id: i64,
    question: &str,
    answer: String,
    is_ai: bool,
    is_pending_correction: bool,
) -> QueryData {
    let escaped_question = escape_html(question).replace('\n', "<br>");
    let button_html = build_pending_correction_button(origin, question_id, is_pending_correction);
    let question_html = if button_html.is_empty() {
        escaped_question
    } else {
        format!(
            "<div style=\"display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;\"><span style=\"flex:1 1 auto;min-width:0;\">{}</span>{}</div>",
            escaped_question, button_html
        )
    };

    QueryData {
        id: question_id,
        question: question_html,
        answer,
        is_ai,
        is_pending_correction,
    }
}

#[derive(Debug, Clone, Copy)]
enum QuestionKind {
    Single,
    Multiple,
    Judgement,
    Completion,
}

impl QuestionKind {
    fn chinese_name(&self) -> &'static str {
        match self {
            QuestionKind::Single => "单选",
            QuestionKind::Multiple => "多选",
            QuestionKind::Judgement => "判断",
            QuestionKind::Completion => "填空",
        }
    }

    fn prompt_hint(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "这是单选题，只有一个正确答案。answer 只能写正确选项的完整文字（与【选项】原文一致），禁止写 A/B/C/D，也禁止写成「B. 传动角」这种带字母前缀的形式，应直接写「传动角」。"
            }
            QuestionKind::Multiple => {
                "这是多选题，可能有多个正确答案。answer 只写各正确选项的完整文字，用 ### 连接（顺序不限）。禁止写 ABD，禁止写「A. xxx###C. yyy」这种带字母前缀的形式。"
            }
            QuestionKind::Judgement => {
                "这是判断题。answer 只能是「正确」或「错误」二字之一。禁止写 A/B，禁止写「A. 正确」。"
            }
            QuestionKind::Completion => {
                "这是填空题。answer 只填空白处应填的内容本身；若有多个空，用 ### 连接。不要加第1空/①/A. 等序号前缀。"
            }
        }
    }

    /// 题型对应的典型对答示例（写入 prompt；前端也会以多轮对话注入）
    fn few_shot_block(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "【作答示例】\n\
题目：凸轮机构中从动件运动规律取决于（ ）。\n\
选项：A. 压力角  B. 传动角  C. 极力夹角\n\
正确输出：{\"answer\": \"传动角\"}\n\
错误输出：{\"answer\": \"B. 传动角\"} 或 {\"answer\": \"B\"}\n"
            }
            QuestionKind::Multiple => {
                "【作答示例】\n\
题目：下列属于输入设备的有（ ）。\n\
选项：A. 键盘  B. 显示器  C. 鼠标  D. 打印机\n\
正确输出：{\"answer\": \"键盘###鼠标\"}\n\
错误输出：{\"answer\": \"AC\"} 或 {\"answer\": \"A. 键盘###C. 鼠标\"}\n"
            }
            QuestionKind::Judgement => {
                "【作答示例】\n\
题目：地球绕太阳公转一周约为 365 天。\n\
正确输出：{\"answer\": \"正确\"}\n\
错误输出：{\"answer\": \"A\"} 或 {\"answer\": \"A. 正确\"}\n"
            }
            QuestionKind::Completion => {
                "【作答示例】\n\
题目：中国的首都是____，最大的城市是____。\n\
正确输出：{\"answer\": \"北京###上海\"}\n\
错误输出：{\"answer\": \"第1空：北京###第2空：上海\"}\n"
            }
        }
    }
}

fn detect_question_kind(query_type: &str) -> Option<QuestionKind> {
    let trimmed = query_type.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.to_lowercase();

    if normalized.contains("single") || trimmed.contains("单选") || trimmed.contains("单项选择")
    {
        Some(QuestionKind::Single)
    } else if normalized.contains("multiple")
        || trimmed.contains("多选")
        || trimmed.contains("多项选择")
    {
        Some(QuestionKind::Multiple)
    } else if normalized.contains("judgement")
        || normalized.contains("judgment")
        || trimmed.contains("判断")
    {
        Some(QuestionKind::Judgement)
    } else if normalized.contains("completion") || trimmed.contains("填空") {
        Some(QuestionKind::Completion)
    } else {
        None
    }
}

fn build_model_query_prompt(
    title: &str,
    options: Option<&str>,
    query_type: Option<&str>,
) -> String {
    let mut q = String::from(
        "你是一个专业的答题助手。请按以下要求作答：\n"
    );

    q.push_str("1. 先在内部完成审题与推理（可简要），再给出最终答案。\n");
    q.push_str("2. 最后一行输出**唯一**一个 JSON 对象，不要用 markdown 代码块包裹，JSON 前后不要附加说明。\n");
    q.push_str("3. JSON 格式严格为：{\"answer\": \"最终答案\"}\n");
    q.push_str("4. answer 只写答案正文本身：选择题必须与【选项】中去掉「A.」「B.」后的文字完全一致；判断题只写「正确」或「错误」；填空题只写填空内容。\n");
    q.push_str("5. 严禁把选项字母写进 answer：不要写 A/B/C/D，不要写「B. 传动角」「D. meeting」，应直接写「传动角」「meeting」。不要把分析过程写进 answer。\n\n");

    if let Some(raw_type) = query_type.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(kind) = detect_question_kind(raw_type) {
            q.push_str(&format!("【题目类型：{}题】\n", kind.chinese_name()));
            q.push_str(&format!("提示：{}\n", kind.prompt_hint()));
            q.push_str(kind.few_shot_block());
            q.push('\n');
        } else {
            q.push_str(&format!("【题目类型字段：{}】\n", raw_type));
        }
    }

    q.push_str(&format!("【题目】\n{}\n", title));

    if let Some(options) = options.map(str::trim).filter(|value| !value.is_empty()) {
        q.push_str(&format!("【选项】\n{}\n", options));
    }

    q.push_str("\n请作答，并在最后输出答案 JSON：");

    q
}

const SAME_QUESTION_CHECK_PREFIX: &str = "__SAME_QUESTION_CHECK__:";
const SAME_QUESTION_CANDIDATE_LIMIT: usize = 5;

fn build_same_question_check_prompt(title: &str, options: Option<&str>, candidates: &[QuestionMatch]) -> String {
    let candidate_list: Vec<serde_json::Value> = candidates
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "question": c.question,
                "options": c.options,
            })
        })
        .collect();

    let payload = serde_json::json!({
        "title": title,
        "options": options,
        "candidates": candidate_list,
    });

    format!(
        "{}{}",
        SAME_QUESTION_CHECK_PREFIX,
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
    )
}

fn parse_same_question_result(content: &str) -> Option<i64> {
    let trimmed = content.trim();
    if trimmed.is_empty() || is_model_error(trimmed).is_some() {
        return None;
    }

    let json_str = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => &trimmed[start..=end],
        _ => trimmed,
    };

    let value: Value = serde_json::from_str(json_str).ok()?;
    let same = value.get("same").and_then(|v| v.as_bool()).unwrap_or(false);
    if !same {
        return None;
    }
    value
        .get("matched_id")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            value
                .get("matched_id")
                .and_then(|v| v.as_u64())
                .map(|v| v as i64)
        })
}

fn build_normal_model_query(request: &QueryRequest, _has_url: bool) -> String {
    // 图片和文件不再改走单独的视觉题。链接留在正文里，图片数组另附。
    build_model_query_prompt(
        &request.title,
        request.options.as_deref(),
        request.query_type.as_deref(),
    )
}

fn emit_model_call_request(app: Option<&AppHandle>, request_id: &str, query: &str, images: &[String]) {
    if let Some(app) = app {
        let payload = serde_json::json!({
            "request_id": request_id,
            "query": query,
            "images": images,
        });
        if let Err(e) = app.emit("model-call-request", payload) {
            println!("⚠️ emit model-call-request failed: {}", e);
        } else {
            println!("📣 Emitted model-call-request via Tauri event");
        }
    }
}

async fn wait_and_store_ai_answer(
    logger: &crate::logger::RequestLogger,
    app: Option<&AppHandle>,
    request: &QueryRequest,
    request_id: &str,
    request_origin: &str,
    has_url: bool,
) -> (u16, QueryResponse) {
    let formatted_query = build_normal_model_query(request, has_url);
    logger.send_model_call_request(request_id.to_string(), formatted_query.clone(), request.images.clone());
    emit_model_call_request(app, request_id, &formatted_query, &request.images);

    // 覆盖前端超时 × 重试；absolute 防止 keepalive 无限续命
    let (inactivity_secs, absolute_secs) = model_wait_budget_secs(has_url);
    println!(
        "⏳ model wait budget: inactivity={}s absolute={}s (has_url={})",
        inactivity_secs, absolute_secs, has_url
    );
    match logger
        .wait_for_model_response(request_id.to_string(), inactivity_secs, absolute_secs)
        .await
    {
        Ok(model_content) => {
            println!("✅ Received model response: {}", model_content);
            if let Some((status, err_msg)) = classify_model_failure(&model_content) {
                return (status, QueryResponse::error(err_msg));
            }

            let image_hash = images_fingerprint(&request.images);
            let mut extracted_answer = extract_answer_from_json(&model_content);
            if model_content.contains("题目不完整,无法确定具体问题.") {
                extracted_answer = String::new();
                println!("⚠️ 检测到题目不完整,将答案留空");
            }
            extracted_answer = extracted_answer.trim().to_string();
            // 去掉 A./B. 前缀，纯字母映射为选项正文，避免返回/入库带序号的答案
            let before_norm = extracted_answer.clone();
            extracted_answer = normalize_answer_against_options(
                &extracted_answer,
                request.options.as_deref(),
            );
            if extracted_answer != before_norm {
                println!(
                    "🔧 答案已规范化: [{}] → [{}]",
                    before_norm, extracted_answer
                );
            }

            let inserted_id = if extracted_answer.is_empty() {
                println!("⚠️ AI最终处理结果答案为空,跳过保存题目");
                0
            } else if !should_auto_add_to_question_bank() {
                println!("ℹ️ autoAddToQuestionBank=false，跳过将 AI 回答写入本地题库");
                0
            } else {
                match insert_ai_response(
                    &request.title,
                    &extracted_answer,
                    request.options.clone(),
                    request.query_type.clone(),
                    true,
                    image_hash.as_deref(),
                ) {
                    Ok(id) => {
                        println!("✅ AI response stored to database");
                        id
                    }
                    Err(e) => {
                        println!("❌ Failed to store AI response: {}", e);
                        0
                    }
                }
            };

            let data = build_query_data(
                request_origin,
                inserted_id,
                &request.title,
                extracted_answer,
                true,
                false,
            );
            (200, QueryResponse::success(vec![data]))
        }
        Err(e) => {
            println!("❌ Model call timeout or error: {}", e);
            (
                408,
                QueryResponse::error(format!("Model call failed: {}", e)),
            )
        }
    }
}

async fn resolve_query_with_same_question_check(
    logger: &crate::logger::RequestLogger,
    app: Option<&AppHandle>,
    request: &QueryRequest,
    request_id: &str,
    request_origin: &str,
) -> (u16, QueryResponse) {
    let image_hash = images_fingerprint(&request.images);
    let mut has_url = !request.images.is_empty() || contains_url(&request.title);
    if let Some(options) = &request.options {
        if !has_url {
            has_url = contains_url(options);
        }
    }

    // 1) 精确命中直接返回
    match query_database_exact(&request.title, request.options.as_deref(), image_hash.as_deref()).await {
        Ok(exact_hits) if !exact_hits.is_empty() => {
            println!("✅ 精确匹配命中: {} 条", exact_hits.len());
            let data_list: Vec<QueryData> = exact_hits
                .into_iter()
                .map(|m| {
                    let answer = normalize_answer_against_options(
                        &m.answer,
                        request.options.as_deref(),
                    );
                    build_query_data(
                        request_origin,
                        m.id,
                        &m.question,
                        answer,
                        m.is_ai,
                        m.is_pending_correction,
                    )
                })
                .collect();
            return (200, QueryResponse::success(data_list));
        }
        Ok(_) => {
            println!("🔍 无精确匹配: {}", request.title);
        }
        Err(e) => {
            eprintln!("Database exact query error: {}", e);
            return (
                500,
                QueryResponse::error(format!("Database error: {}", e)),
            );
        }
    }

    // 2) 模糊候选 → AI 同题判断
    let candidates = match query_database_candidates(
        &request.title,
        request.options.as_deref(),
        image_hash.as_deref(),
        SAME_QUESTION_CANDIDATE_LIMIT,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Database candidate query error: {}", e);
            return (
                500,
                QueryResponse::error(format!("Database error: {}", e)),
            );
        }
    };

    if !candidates.is_empty() {
        println!(
            "🤖 发现 {} 条近似候选，请求 AI 同题判断",
            candidates.len()
        );
        let check_prompt =
            build_same_question_check_prompt(&request.title, request.options.as_deref(), &candidates);
        logger.send_model_call_request(request_id.to_string(), check_prompt.clone(), Vec::new());
        emit_model_call_request(app, request_id, &check_prompt, &[]);

        match logger
            .wait_for_model_response(request_id.to_string(), 30, 45)
            .await
        {
            Ok(judge_content) => {
                println!("✅ 同题判断结果: {}", judge_content);
                // 未选择模型等客户端错误：直接返回，避免再回落正常答题又等一轮
                if let Some((status, err_msg)) = classify_model_failure(&judge_content) {
                    if status == 400 && err_msg.contains("未选择模型") {
                        return (status, QueryResponse::error(err_msg));
                    }
                }
                if let Some(matched_id) = parse_same_question_result(&judge_content) {
                    if let Some(matched) = candidates.iter().find(|c| c.id == matched_id).cloned() {
                        let answer = normalize_answer_against_options(
                            &matched.answer,
                            request.options.as_deref(),
                        );
                        let response_id = if should_auto_add_to_question_bank() {
                            match insert_ai_response(
                                &request.title,
                                &answer,
                                request.options.clone(),
                                request.query_type.clone(),
                                matched.is_ai,
                                image_hash.as_deref(),
                            ) {
                                Ok(id) => {
                                    println!(
                                        "✅ 同题变体已入库, matched_id={}, new_id={}",
                                        matched_id, id
                                    );
                                    id
                                }
                                Err(e) => {
                                    println!("❌ 同题变体入库失败: {}，仍返回已有答案", e);
                                    matched.id
                                }
                            }
                        } else {
                            println!(
                                "ℹ️ autoAddToQuestionBank=false，同题命中不入库，直接返回 matched_id={}",
                                matched_id
                            );
                            matched.id
                        };

                        let data = build_query_data(
                            request_origin,
                            response_id,
                            &request.title,
                            answer,
                            matched.is_ai,
                            false,
                        );
                        return (200, QueryResponse::success(vec![data]));
                    }

                    // matched_id 不在候选中，尝试按 id 查库
                    // 按 id 取回的记录同样要图片指纹一致，不能把别的图片题的答案当成这题的
                    if let Some(matched) = get_ai_response_by_id(matched_id)
                        .ok()
                        .filter(|m| m.image_hash.as_deref().filter(|h| !h.is_empty()) == image_hash.as_deref())
                    {
                        let answer = normalize_answer_against_options(
                            &matched.answer,
                            request.options.as_deref(),
                        );
                        let response_id = if should_auto_add_to_question_bank() {
                            match insert_ai_response(
                                &request.title,
                                &answer,
                                request.options.clone(),
                                request.query_type.clone(),
                                matched.is_ai,
                                image_hash.as_deref(),
                            ) {
                                Ok(id) => id,
                                Err(_) => matched.id,
                            }
                        } else {
                            matched.id
                        };
                        let data = build_query_data(
                            request_origin,
                            response_id,
                            &request.title,
                            answer,
                            matched.is_ai,
                            false,
                        );
                        return (200, QueryResponse::success(vec![data]));
                    }

                    println!(
                        "⚠️ 同题判断返回的 matched_id={} 无效，回落正常答题",
                        matched_id
                    );
                } else {
                    println!("ℹ️ AI 判定为不同题或解析失败，回落正常答题");
                }
            }
            Err(e) => {
                println!("⚠️ 同题判断超时/失败: {}，回落正常答题", e);
            }
        }
    } else {
        println!("🔍 无近似候选，直接走正常 AI 答题");
    }

    // 3) 正常 AI 答题
    wait_and_store_ai_answer(logger, app, request, request_id, request_origin, has_url).await
}

/// 启动HTTP服务器
#[tauri::command]
pub async fn start_server(
    port: u16,
    bind_address: String,
    state: State<'_, ServerState>,
) -> Result<ServerInfo, String> {
    // 验证端口号
    if port == 0 {
        return Err("Invalid port number".to_string());
    }

    // 检查服务器是否已经在运行
    {
        let info = state.info.lock();
        if info.running {
            return Ok(info.clone());
        }
    }

    // 克隆状态以在异步任务中使用
    let logger = state.logger.clone();

    // 创建请求记录中间件（用于其他路由）
    let logging_middleware = warp::log::custom(move |info| {
        let method = info.method().to_string();
        let path = info.path().to_string();
        let status = info.status().as_u16();
        let response_time = info.elapsed().as_millis() as u64;

        println!(
            "🔍 Logging middleware triggered: {} {} - Status: {}, Time: {}ms",
            method, path, status, response_time
        );

        // 对于非query路由,使用简化的日志记录
        logger.log_request(
            method,
            path,
            status,
            response_time,
            None, // request_body
            None, // response_body
            None, // headers
            None, // ip
            None, // user_agent
        );

        println!("✅ Request logged successfully");
    });

    // 状态路由
    let status_route = warp::path("api")
        .and(warp::path("status"))
        .and(warp::get())
        .map(|| {
            warp::reply::json(&serde_json::json!({
                "status": "running",
                "message": "Server is running"
            }))
        });

    // 时间路由
    let time_route = warp::path("api")
        .and(warp::path("time"))
        .and(warp::get())
        .map(|| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            warp::reply::json(&serde_json::json!({
                "timestamp": now,
                "time": chrono::Utc::now().to_rfc3339()
            }))
        });

    // Echo路由
    let echo_route = warp::path("api")
        .and(warp::path("echo"))
        .and(warp::post())
        .and(warp::body::json())
        .map(|body: serde_json::Value| {
            warp::reply::json(&serde_json::json!({
                "echo": body,
                "received_at": chrono::Utc::now().to_rfc3339()
            }))
        });

    // 数据库查询路由 - 带有详细日志记录
    let logger_for_query = state.logger.clone();
    let app_for_query = state.app_handle.clone();

    // POST 请求处理
    let query_post_route = warp::path("query")
        .and(warp::post())
        .and(warp::header::headers_cloned())
        .and(warp::body::json())
        .and_then(move |headers: HeaderMap, request: QueryRequest| {
            let logger = logger_for_query.clone();
            let app = app_for_query.clone();
            async move {
                // 空白请求（例如探测）不记录日志，也不请求 AI
                if is_blank_question(&request.title, &request.images) {
                    return Ok::<_, warp::Rejection>(warp::reply::json(&QueryResponse::error(
                        "题目内容为空".to_string(),
                    )));
                }
                let start_time = std::time::Instant::now();
                let request_body = request_body_for_log(&request);
                
                // 生成唯一请求ID
                let request_id = uuid::Uuid::new_v4().to_string();
                
                // 提取请求头信息
                let mut header_map = HashMap::new();
                for (key, value) in headers.iter() {
                    if let Ok(value_str) = value.to_str() {
                        header_map.insert(key.to_string(), value_str.to_string());
                    }
                }
                
                // 提取IP和User-Agent
                let user_agent = headers.get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let ip = headers.get("x-forwarded-for")
                    .or_else(|| headers.get("x-real-ip"))
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "127.0.0.1".to_string());

                // 记录请求开始
                logger.log_request_start(
                    request_id.clone(),
                    "POST".to_string(),
                    "/query".to_string(),
                    Some(request_body),
                    Some(header_map),
                    Some(ip),
                    user_agent,
                );

                let request_origin = resolve_request_origin(&headers);

                // 独立任务执行：请求端断开时仍会写完 completed 日志，避免 UI 一直「处理中」
                let logger_task = logger.clone();
                let app_task = app.clone();
                let request_task = request;
                let request_id_task = request_id.clone();
                let request_origin_task = request_origin;
                let join = tokio::spawn(async move {
                    let result = resolve_query_with_same_question_check(
                        &logger_task,
                        app_task.as_ref(),
                        &request_task,
                        &request_id_task,
                        &request_origin_task,
                    )
                    .await;
                    let response_time = start_time.elapsed().as_millis() as u64;
                    let response_body = serde_json::to_string(&result.1).unwrap_or_default();
                    if let Some(app) = app_task.as_ref() {
                        let _ = app.emit(
                            "request-log-complete",
                            serde_json::json!({
                                "id": request_id_task,
                                "status": result.0,
                                "response_time": response_time,
                                "stage": "completed",
                                "path": "/query",
                                "method": "POST",
                                "response_body": response_body,
                            }),
                        );
                    }
                    logger_task.log_request_complete(
                        request_id_task,
                        "POST".to_string(),
                        "/query".to_string(),
                        result.0,
                        response_time,
                        Some(serde_json::to_string(&result.1).unwrap_or_default()),
                    );
                    result
                });

                match join.await {
                    Ok(result) => Ok::<_, warp::Rejection>(warp::reply::json(&result.1)),
                    Err(e) => {
                        eprintln!("❌ /query POST task join error: {}", e);
                        Ok(warp::reply::json(&QueryResponse::error(
                            "Internal query task failed".to_string(),
                        )))
                    }
                }
            }
        });

    // GET 请求处理
    let logger_for_query_get = state.logger.clone();
    let app_for_query_get = state.app_handle.clone();
    let query_get_route = warp::path("query")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and(warp::query::<HashMap<String, String>>())
        .and_then(move |headers: HeaderMap, params: HashMap<String, String>| {
            let logger = logger_for_query_get.clone();
            let app = app_for_query_get.clone();
            async move {
                let start_time = std::time::Instant::now();
                
                // 从查询参数构建 QueryRequest
                let title = params.get("title").cloned().unwrap_or_default();
                // 空白请求（例如 OCS 的连接探测回退成不带参数的 GET）不记录日志，也不请求 AI
                if is_blank_question(&title, &[]) {
                    return Ok::<_, warp::Rejection>(warp::reply::json(&QueryResponse::error(
                        "题目内容为空".to_string(),
                    )));
                }
                let options = params.get("options").cloned();
                let query_type = params.get("type").cloned();
                
                let request = QueryRequest {
                    title: title.clone(),
                    options,
                    query_type,
                    images: Vec::new(),
                };
                
                let request_body = request_body_for_log(&request);
                
                // 生成唯一请求ID
                let request_id = uuid::Uuid::new_v4().to_string();
                
                // 提取请求头信息
                let mut header_map = HashMap::new();
                for (key, value) in headers.iter() {
                    if let Ok(value_str) = value.to_str() {
                        header_map.insert(key.to_string(), value_str.to_string());
                    }
                }
                
                // 提取IP和User-Agent
                let user_agent = headers.get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let ip = headers.get("x-forwarded-for")
                    .or_else(|| headers.get("x-real-ip"))
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "127.0.0.1".to_string());

                // 记录请求开始
                logger.log_request_start(
                    request_id.clone(),
                    "GET".to_string(),
                    "/query".to_string(),
                    Some(request_body),
                    Some(header_map),
                    Some(ip),
                    user_agent,
                );

                let request_origin = resolve_request_origin(&headers);

                let logger_task = logger.clone();
                let app_task = app.clone();
                let request_task = request;
                let request_id_task = request_id.clone();
                let request_origin_task = request_origin;
                let join = tokio::spawn(async move {
                    let result = resolve_query_with_same_question_check(
                        &logger_task,
                        app_task.as_ref(),
                        &request_task,
                        &request_id_task,
                        &request_origin_task,
                    )
                    .await;
                    let response_time = start_time.elapsed().as_millis() as u64;
                    let response_body = serde_json::to_string(&result.1).unwrap_or_default();
                    if let Some(app) = app_task.as_ref() {
                        let _ = app.emit(
                            "request-log-complete",
                            serde_json::json!({
                                "id": request_id_task,
                                "status": result.0,
                                "response_time": response_time,
                                "stage": "completed",
                                "path": "/query",
                                "method": "GET",
                                "response_body": response_body,
                            }),
                        );
                    }
                    logger_task.log_request_complete(
                        request_id_task,
                        "GET".to_string(),
                        "/query".to_string(),
                        result.0,
                        response_time,
                        Some(serde_json::to_string(&result.1).unwrap_or_default()),
                    );
                    result
                });

                match join.await {
                    Ok(result) => Ok::<_, warp::Rejection>(warp::reply::json(&result.1)),
                    Err(e) => {
                        eprintln!("❌ /query GET task join error: {}", e);
                        Ok(warp::reply::json(&QueryResponse::error(
                            "Internal query task failed".to_string(),
                        )))
                    }
                }
            }
        });

    // 合并 GET 和 POST 路由
    let query_route = query_head_route().or(query_post_route).or(query_get_route);

    let mark_pending_correction_route = warp::path("api")
        .and(warp::path("questions"))
        .and(warp::path::param::<i64>())
        .and(warp::path("pending-correction"))
        .and(warp::post())
        .and_then(|question_id: i64| async move {
            match set_question_pending_correction(question_id, true).await {
                Ok(_) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({
                        "success": true,
                        "message": "题目已标记为待修正",
                        "id": question_id,
                    })),
                    warp::http::StatusCode::OK,
                )),
                Err(error) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({
                        "success": false,
                        "message": error,
                    })),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )),
            }
        });

    // 模型调用响应路由
    let logger_for_model_response = state.logger.clone();
    let model_response_route = warp::path("api")
        .and(warp::path("model"))
        .and(warp::path("response"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |request: ModelCallResponseRequest| {
            let logger = logger_for_model_response.clone();
            async move {
                println!(
                    "🤖 Received model call response for request_id: {}",
                    request.request_id
                );

                let is_success = request
                    .is_success
                    .unwrap_or_else(|| is_model_error(&request.content).is_none());

                // 发送模型调用响应事件
                logger.send_model_call_response(
                    request.request_id.clone(),
                    request.content.clone(),
                    request.reasoning_content.clone(),
                    is_success,
                );

                if is_success {
                    match store_ai_response_to_database(&request.request_id, &request.content).await
                    {
                        Ok(_) => println!("✅ AI响应已成功存储到数据库"),
                        Err(e) => println!("❌ 存储AI响应到数据库失败: {}", e),
                    }
                } else {
                    println!("⚠️ 检测到模型错误响应,跳过存储到数据库");
                }

                // 返回成功响应
                let response = serde_json::json!({
                    "success": true,
                    "message": "Model response received successfully"
                });

                Ok::<_, warp::Rejection>(warp::reply::json(&response))
            }
        });

    // SSE日志流路由
    let logger_for_sse = state.logger.clone();
    let sse_logs_route = warp::path("api")
        .and(warp::path("logs"))
        .and(warp::path("stream"))
        .and(warp::get())
        .map(move || {
            println!("🔌 New SSE connection established");
            let receiver = logger_for_sse.subscribe();
            println!(
                "📻 SSE receiver created, current subscriber count: {}",
                logger_for_sse.subscriber_count()
            );

            let stream = BroadcastStream::new(receiver).filter_map(|result| async move {
                match result {
                    Ok(event) => {
                        println!("📤 Sending SSE event: {:?}", event);
                        let json_data = serde_json::to_string(&event).ok()?;

                        // 根据事件类型设置不同的event名称
                        let event_name = match &event {
                            crate::logger::SSEEvent::RequestLog(_) => "log",
                            crate::logger::SSEEvent::ModelCallRequest(_) => "model_call_request",
                            crate::logger::SSEEvent::ModelCallProgress(_) => "model_call_progress",
                            crate::logger::SSEEvent::ModelCallResponse(_) => "model_call_response",
                        };

                        Some(Ok::<_, warp::Error>(
                            warp::sse::Event::default()
                                .event(event_name)
                                .data(json_data),
                        ))
                    }
                    Err(e) => {
                        println!("❌ SSE stream error: {:?}", e);
                        None
                    }
                }
            });

            warp::sse::reply(stream)
        });

    let root_route = warp::path::end()
        .and(warp::get())
        .map(|| warp::reply::html(QUERY_TEST_PAGE_HTML));

    // 根路由的HEAD方法
    let app_handle_clone = state.app_handle.clone();
    let root_head_route = warp::path::end()
        .and(warp::head())
        .map(move || {
            if let Some(app) = &app_handle_clone {
                let _ = app.emit("ocs-head-received", ());
            }
            warp::reply::with_header("Hello,OCS", "content-type", "text/plain")
        });

    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["content-type", "authorization"])
        .allow_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"]);

    // 将需要记录日志的路由组合在一起（query路由已经有自己的详细日志记录）
    let logged_routes = status_route
        .or(time_route)
        .or(echo_route)
        .with(logging_middleware);

    // 模型调用进度路由（用于流式输出心跳）
    let logger_for_model_progress = state.logger.clone();
    let model_progress_route = warp::path("api")
        .and(warp::path("model"))
        .and(warp::path("progress"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |request: ModelCallProgressRequest| {
            let logger = logger_for_model_progress.clone();
            async move {
                println!(
                    "📶 Received model call progress for request_id: {}",
                    request.request_id
                );
                logger
                    .send_model_call_progress(request.request_id.clone(), request.content.clone());
                let response = serde_json::json!({
                    "success": true,
                    "message": "Model progress received successfully"
                });
                Ok::<_, warp::Rejection>(warp::reply::json(&response))
            }
        });

    // 登录路由：验证管理员token或用户token
    let login_route = warp::path("api")
        .and(warp::path("login"))
        .and(warp::post())
        .and(warp::body::json())
        .and_then(move |body: serde_json::Value| async move {
            let token = body
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if token.is_empty() {
                let resp = serde_json::json!({"success": false, "message": "token不能为空"});
                return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
            }
            // 读取配置文件
            let config = read_app_config();
            // 验证管理员token
            let admin_token = config
                .get("adminToken")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !admin_token.is_empty() && token == admin_token {
                let resp = serde_json::json!({"success": true, "role": "admin", "name": "管理员"});
                return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
            }
            // 验证普通用户token
            if let Some(users) = config
                .get("multiUser")
                .and_then(|m| m.get("users"))
                .and_then(|u| u.as_array())
            {
                for user in users {
                    let user_token = user.get("token").and_then(|v| v.as_str()).unwrap_or("");
                    if !user_token.is_empty() && token == user_token {
                        let name = user.get("name").and_then(|v| v.as_str()).unwrap_or("用户");
                        let resp =
                            serde_json::json!({"success": true, "role": "user", "name": name});
                        return Ok::<_, warp::Rejection>(warp::reply::json(&resp));
                    }
                }
            }
            let resp = serde_json::json!({"success": false, "message": "token无效"});
            Ok::<_, warp::Rejection>(warp::reply::json(&resp))
        });

    // GET /api/models — 读取模型配置（需要管理员token验证）
    let models_get_route = warp::path("api")
        .and(warp::path("models"))
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and_then(|auth: Option<String>| async move {
            if !check_admin_token(&auth) {
                return Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": false, "message": "未授权"})),
                    warp::http::StatusCode::UNAUTHORIZED,
                ));
            }
            let data: serde_json::Value = crate::storage::read_config_file("model_config.json")
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}));
            Ok::<_, warp::Rejection>(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"success": true, "data": data})),
                warp::http::StatusCode::OK,
            ))
        });

    // PUT /api/models — 写入模型配置（需要管理员token验证）
    let models_put_route = warp::path("api")
        .and(warp::path("models"))
        .and(warp::put())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and_then(|auth: Option<String>, body: serde_json::Value| async move {
            if !check_admin_token(&auth) {
                return Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": false, "message": "未授权"})),
                    warp::http::StatusCode::UNAUTHORIZED,
                ));
            }
            match crate::storage::write_config_file("model_config.json", &body.to_string()) {
                Ok(_) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"success": true})),
                    warp::http::StatusCode::OK,
                )),
                Err(e) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::json(
                        &serde_json::json!({"success": false, "message": e.to_string()}),
                    ),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )),
            }
        });

    // 组合所有路由（query路由和SSE路由不需要额外的日志中间件）
    let routes = root_route
        .or(root_head_route)
        .or(logged_routes)
        .or(query_route)
        .or(mark_pending_correction_route)
        .or(model_response_route)
        .or(model_progress_route)
        .or(sse_logs_route)
        .or(login_route)
        .or(models_get_route)
        .or(models_put_route)
        .with(cors);

    // 解析绑定地址
    let bind_ip: [u8; 4] = if bind_address == "0.0.0.0" {
        [0, 0, 0, 0]
    } else if bind_address == "127.0.0.1" {
        [127, 0, 0, 1]
    } else {
        // 尝试解析其他IP地址
        let parts: Vec<&str> = bind_address.split('.').collect();
        if parts.len() != 4 {
            return Err(format!("Invalid IP address format: {}", bind_address));
        }
        let mut ip = [0u8; 4];
        for (i, part) in parts.iter().enumerate() {
            match part.parse::<u8>() {
                Ok(octet) => ip[i] = octet,
                Err(_) => return Err(format!("Invalid IP address format: {}", bind_address)),
            }
        }
        ip
    };

    // 先同步绑定端口：端口被占用/无权限时直接把错误返回给界面，
    // 而不是在后台任务里 panic 后界面仍显示“运行中”。
    let (_addr, server_future) = warp::serve(routes)
        .try_bind_ephemeral((bind_ip, port))
        .map_err(|e| {
            format!(
                "无法在 {}:{} 启动服务（端口可能已被其他程序占用，请在设置中更换端口）: {}",
                bind_address, port, e
            )
        })?;
    let server_handle = tokio::spawn(server_future);

    // 更新状态
    let result = {
        let mut info = state.info.lock();
        info.running = true;
        info.port = Some(port);
        // 根据绑定地址生成正确的URL
        let url_host = if bind_address == "0.0.0.0" {
            "localhost".to_string()
        } else {
            bind_address.clone()
        };
        info.url = Some(format!("http://{}:{}", url_host, port));
        info.clone()
    };

    // 存储服务器句柄
    *state.handle.lock() = Some(server_handle);

    begin_server_activity();

    Ok(result)
}

/// 停止HTTP服务器
///
/// # 参数
/// * `state` - 服务器状态管理
///
/// # 返回值
/// * `Ok(ServerInfo)` - 服务器停止成功,返回服务器信息
/// * `Err(String)` - 服务器停止失败,返回错误信息
#[tauri::command]
pub async fn stop_server(state: State<'_, ServerState>) -> Result<ServerInfo, String> {
    {
        let info = state.info.lock();
        if !info.running {
            return Ok(info.clone());
        }
    }

    // 停止服务器
    if let Some(handle) = state.handle.lock().take() {
        handle.abort();
    }

    end_server_activity();

    // 更新状态
    let result = {
        let mut info = state.info.lock();
        info.running = false;
        info.port = None;
        info.url = None;
        info.clone()
    };

    Ok(result)
}

/// 获取服务器状态
///
/// # 参数
/// * `state` - 服务器状态管理
///
/// # 返回值
/// * `Ok(ServerInfo)` - 返回当前服务器状态信息
#[tauri::command]
pub async fn get_server_status(state: State<'_, ServerState>) -> Result<ServerInfo, String> {
    let info = state.info.lock();
    Ok(info.clone())
}

/// 存储AI响应到数据库
///
/// # Arguments
/// * `request_id` - 请求ID
/// * `content` - AI响应内容
///
/// # Returns
/// * `Result<(), String>` - 成功返回Ok(()),失败返回错误信息
async fn store_ai_response_to_database(request_id: &str, content: &str) -> Result<(), String> {
    // 记录AI响应信息,准备存储到数据库
    println!(
        "📝 准备存储AI响应到数据库: request_id={}, content_length={}",
        request_id,
        content.len()
    );

    // 如果回答是"题目不完整,无法确定具体问题.",则记录日志
    if content.contains("题目不完整,无法确定具体问题.") {
        println!("⚠️ 检测到题目不完整 (in callback)");
    }

    // TODO: 目前无法在此处存储,因为缺少原始问题的标题 (Title).
    // 完整的存储逻辑已在 query_post_route 中实现,那里有完整的上下文.
    // 如果将来需要支持异步回调存储,需要实现通过 request_id 查找原始 title 的机制.

    Ok(())
}

/// 从选项文本解析 A/B/C → 选项正文
fn parse_option_letter_map(options: Option<&str>) -> HashMap<char, String> {
    let mut map = HashMap::new();
    let Some(options) = options.map(str::trim).filter(|s| !s.is_empty()) else {
        return map;
    };
    let Ok(re) = Regex::new(r"^([A-Za-z])([\.、．\)])\s*(.+)$") else {
        return map;
    };
    for raw in options.replace("\r\n", "\n").lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(caps) = re.captures(line) {
            let letter = caps
                .get(1)
                .and_then(|m| m.as_str().chars().next())
                .map(|c| c.to_ascii_uppercase());
            let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let text = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
            // 避免把正文「C、H、O、N…」误当成选项标号行
            if sep == "、"
                && text
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false)
                && text.chars().nth(1) == Some('、')
            {
                continue;
            }
            if let (Some(letter), true) = (letter, !text.is_empty()) {
                map.insert(letter, text.to_string());
            }
        }
    }
    map
}

/// 去掉行首选项字母前缀：`B. 传动角` → `传动角`
/// 有选项表时，仅当去前缀后能对应到某选项正文才剥离。
fn strip_leading_option_label(text: &str, map: &HashMap<char, String>) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let patterns: [(&str, bool); 2] = [
        (r"^([A-Za-z])([\.、．\)])\s+(.+)$", false),
        (r"^([A-Za-z])([\.、．\)])(.+)$", true),
    ];

    for (pat, tight) in patterns {
        let Ok(re) = Regex::new(pat) else {
            continue;
        };
        let Some(caps) = re.captures(trimmed) else {
            continue;
        };
        let Some(letter) = caps
            .get(1)
            .and_then(|m| m.as_str().chars().next())
            .map(|c| c.to_ascii_uppercase())
        else {
            continue;
        };
        let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let rest = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        if rest.is_empty() {
            continue;
        }
        // 无空格且剩余全是字母：留给纯字母映射
        if tight && rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.len() <= 8 {
            continue;
        }
        if map.is_empty() {
            if sep == "、" {
                continue;
            }
            return rest.to_string();
        }
        if map.get(&letter).map(|s| s.as_str()) == Some(rest) {
            return rest.to_string();
        }
        if map.values().any(|v| v == rest) {
            return rest.to_string();
        }
    }
    trimmed.to_string()
}

/// 将模型/题库答案规范为选项正文（去字母前缀，纯字母映射）
fn normalize_answer_against_options(answer: &str, options: Option<&str>) -> String {
    let raw = answer.trim();
    if raw.is_empty() {
        return String::new();
    }

    let map = parse_option_letter_map(options);
    let parts: Vec<&str> = if raw.contains("###") {
        raw.split("###").collect()
    } else {
        vec![raw]
    };

    let mut normalized: Vec<String> = Vec::new();
    for part in parts {
        let mut p = strip_leading_option_label(part.trim(), &map);
        if p.is_empty() {
            continue;
        }

        let compact: String = p.chars().filter(|c| !c.is_whitespace()).collect();
        if !map.is_empty()
            && !compact.is_empty()
            && compact.chars().all(|c| c.is_ascii_alphabetic())
            && compact.len() <= 8
        {
            let letters: Vec<char> = compact.chars().map(|c| c.to_ascii_uppercase()).collect();
            let texts: Vec<String> = letters
                .iter()
                .filter_map(|ch| map.get(ch).cloned())
                .collect();
            if texts.len() == letters.len() && !texts.is_empty() {
                p = texts.join("###");
            }
        }
        normalized.push(p);
    }

    if normalized.len() == 1 && normalized[0].contains("###") && !raw.contains("###") {
        return normalized[0].clone();
    }
    normalized.join("###")
}

/// 从JSON响应中提取answer字段
///
/// # Arguments
/// * `json_content` - AI返回的JSON字符串
///
/// # Returns
/// * `String` - 提取的答案内容,如果解析失败则返回原始内容
fn extract_answer_from_json(json_content: &str) -> String {
    // 1) 去除可能的 markdown 代码块标记
    let mut cleaned = json_content.trim().to_string();
    if cleaned.starts_with("```json") {
        cleaned = cleaned[7..].to_string();
    } else if cleaned.starts_with("```") {
        cleaned = cleaned[3..].to_string();
    }
    if cleaned.ends_with("```") {
        cleaned = cleaned[..cleaned.len() - 3].to_string();
    }
    cleaned = cleaned.trim().to_string();

    println!("🔍 清理后的内容: {}", cleaned);

    // 提取答案的内部工具函数
    fn extract_field_from_value(v: &Value) -> Option<String> {
        if let Some(answer) = v.get("answer").and_then(|a| a.as_str()) {
            return Some(answer.to_string());
        }
        if let Some(answer) = v.get("anwser").and_then(|a| a.as_str()) {
            return Some(answer.to_string());
        }
        None
    }

    // 2) 首先尝试直接解析整个文本为 JSON
    if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
        if let Some(ans) = extract_field_from_value(&v) {
            println!("✅ 直接解析文本为JSON并提取到答案: {}", ans);
            return ans;
        }
    }

    // 3) 失败则从末尾尝试提取最后一个平衡的 JSON 对象片段
    fn extract_last_balanced_json(text: &str) -> Option<String> {
        let bytes = text.as_bytes();
        let mut end: Option<usize> = None;
        let mut depth: i32 = 0;
        let mut i = bytes.len();
        while i > 0 {
            i -= 1;
            let b = bytes[i];
            if end.is_none() {
                if b == b'}' {
                    end = Some(i);
                    depth = 1;
                    continue;
                }
            } else {
                if b == b'}' {
                    depth += 1;
                } else if b == b'{' {
                    depth -= 1;
                    if depth == 0 {
                        let start = i;
                        let slice = &text[start..=end.unwrap()];
                        return Some(slice.to_string());
                    }
                }
            }
        }
        None
    }

    if let Some(json_str) = extract_last_balanced_json(&cleaned) {
        println!("🔎 发现末尾的JSON片段: {}", json_str);
        if let Ok(v) = serde_json::from_str::<Value>(&json_str) {
            if let Some(ans) = extract_field_from_value(&v) {
                println!("✅ 从末尾JSON片段中提取到答案: {}", ans);
                return ans;
            }
        } else {
            println!("⚠️ 末尾JSON片段解析失败");
        }
    }

    // 4) 使用正则在混合文本中直接捕获 answer 字段
    let re = Regex::new(r#"(?s)\{\s*\"(?:answer|anwser)\"\s*:\s*\"(.*?)\"[\s\S]*?\}"#).unwrap();
    if let Some(caps) = re.captures(&cleaned) {
        if let Some(m) = caps.get(1) {
            let ans = m.as_str().to_string();
            println!("✅ 通过正则从混合文本中捕获到答案: {}", ans);
            return ans;
        }
    }

    // 5) 尝试从中英文"答案:"或"answer:"后面提取文本
    let text_re = Regex::new(r"(?i)(?:答案|answer)[：:]\s*(.+?)(?:\n|$)").unwrap();
    if let Some(caps) = text_re.captures(&cleaned) {
        if let Some(m) = caps.get(1) {
            let ans = m.as_str().trim().to_string();
            if !ans.is_empty() {
                println!("✅ 从\"答案: \"标记后提取到文本: {}", truncate_chars(&ans, 100));
                return ans;
            }
        }
    }

    // 6) 如果内容看起来是纯文本答案（不含JSON结构）,直接返回清理后的内容
    let cleaned_trimmed = cleaned.trim();
    if cleaned_trimmed.len() > 0 && cleaned_trimmed.len() < 2000 && !cleaned_trimmed.starts_with('{') && !cleaned_trimmed.starts_with('[') {
        // 检查是否像是一个直接答案（简短文本,不含复杂结构）
        let lines: Vec<&str> = cleaned_trimmed.lines().filter(|l| !l.trim().is_empty()).collect();
        if lines.len() <= 3 {
            println!("✅ 将纯文本内容作为答案使用: {}", truncate_chars(cleaned_trimmed, 100));
            return cleaned_trimmed.to_string();
        }
    }

    // 7) 回退：返回原始内容
    println!("⚠️ 未能提取到结构化答案,返回原始内容");
    json_content.to_string()
}

fn is_timeout_like_model_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("timeout")
        || lower.contains("超时")
        || lower.contains("no new tokens")
        || lower.contains("aborted")
        || lower.contains("abort")
        || lower.contains("cancelled")
        || lower.contains("canceled")
        || lower.contains("取消")
        || lower.contains("服务已停止")
}

/// 将模型失败文本映射为 RequestLog 状态码：
/// 未选择模型 → 400，超时类 → 408，其它 → 500
fn classify_model_failure(text: &str) -> Option<(u16, String)> {
    let err = is_model_error(text)?;
    if err.contains("未选择模型") || text.contains("未选择模型") {
        Some((400, "错误: 未选择模型".to_string()))
    } else if is_timeout_like_model_failure(&err) || is_timeout_like_model_failure(text) {
        Some((408, err))
    } else {
        Some((500, err))
    }
}

fn is_model_error(text: &str) -> Option<String> {
    let mut cleaned = text.trim().to_string();
    if cleaned.starts_with("```json") {
        cleaned = cleaned[7..].to_string();
    } else if cleaned.starts_with("```") {
        cleaned = cleaned[3..].to_string();
    }
    if cleaned.ends_with("```") {
        cleaned = cleaned[..cleaned.len() - 3].to_string();
    }
    let cleaned = cleaned.trim().to_string();

    if cleaned == "所有AI均查询失败" {
        return Some(cleaned);
    }

    // 兼容半角/全角冒号
    if cleaned.starts_with("错误:")
        || cleaned.starts_with("错误：")
        || cleaned.starts_with("Error:")
        || cleaned.starts_with("API 错误")
    {
        return Some(cleaned);
    }

    if cleaned.contains("\"error\"") {
        if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
            if let Some(err) = v.get("error") {
                if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
                    return Some(msg.to_string());
                }
                return Some(err.to_string());
            }
        }

        fn extract_last_balanced_json(text: &str) -> Option<String> {
            let bytes = text.as_bytes();
            let mut end: Option<usize> = None;
            let mut depth: i32 = 0;
            let mut i = bytes.len();
            while i > 0 {
                i -= 1;
                let b = bytes[i];
                if end.is_none() {
                    if b == b'}' {
                        end = Some(i);
                        depth = 1;
                        continue;
                    }
                } else {
                    if b == b'}' {
                        depth += 1;
                    } else if b == b'{' {
                        depth -= 1;
                        if depth == 0 {
                            let start = i;
                            let slice = &text[start..=end.unwrap()];
                            return Some(slice.to_string());
                        }
                    }
                }
            }
            None
        }

        if let Some(json_str) = extract_last_balanced_json(&cleaned) {
            if let Ok(v) = serde_json::from_str::<Value>(&json_str) {
                if let Some(err) = v.get("error") {
                    if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
                        return Some(msg.to_string());
                    }
                    return Some(err.to_string());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod same_question_tests {
    use super::{
        classify_model_failure, extract_answer_from_json, parse_same_question_result,
        truncate_chars,
    };

    #[test]
    fn wait_budget_covers_answer_search_summary_and_retries() {
        let cfg = serde_json::json!({
            "modelResponseTimeout": 40, "modelRetryCount": 2,
            "webSearch": {"enabled": true, "timeoutSec": 120}
        });
        let (idle, absolute) = super::model_wait_budget_from_config(&cfg, false);
        assert_eq!(idle, 140);
        assert!(absolute >= 40 * 3 * 2 + 40 + 120 + 8 + 60);
        let disabled = serde_json::json!({"modelResponseTimeout": 5, "modelRetryCount": 0,
            "webSearch": {"enabled": false, "timeoutSec": 120}});
        assert_eq!(super::model_wait_budget_from_config(&disabled, false), (30, 75));
        assert_eq!(super::model_wait_budget_from_config(&disabled, true), (30, 105));
    }


    /// OCS 网课助手 5.2.1 按我们给出的题库配置实际发送/接收的数据格式
    #[test]
    fn close_to_tray_defaults_to_on_and_follows_the_setting() {
        use super::close_to_tray_from_config;
        assert!(close_to_tray_from_config(&serde_json::json!({})));
        assert!(close_to_tray_from_config(&serde_json::json!({"closeToTray": true})));
        assert!(!close_to_tray_from_config(&serde_json::json!({"closeToTray": false})));
        // 值不合法时按默认处理，不要因为配置损坏就让窗口关不掉或退不出
        assert!(close_to_tray_from_config(&serde_json::json!({"closeToTray": "no"})));
    }

    #[test]
    fn blank_questions_are_not_real_queries() {
        use super::is_blank_question;
        assert!(is_blank_question("", &[]));
        assert!(is_blank_question("  \n\t ", &[]));
        assert!(is_blank_question("", &["   ".to_string()]));
        assert!(!is_blank_question("1+1=?", &[]));
        // 只有图片的题（标题为空）仍然是真题
        assert!(!is_blank_question("", &["data:image/png;base64,AAAA".to_string()]));
    }

    #[tokio::test]
    async fn ocs_head_probe_on_query_is_answered_locally() {
        use super::query_head_route;
        let route = query_head_route();
        // OCS 5.2.1 探测：HEAD <题库地址>?t=<时间戳>
        let res = warp::test::request().method("HEAD").path("/query?t=1792157850068").reply(&route).await;
        assert_eq!(res.status(), 200);
        // 只处理 HEAD，不会吞掉真正的查询
        let post = warp::test::request().method("POST").path("/query").reply(&route).await;
        assert_ne!(post.status(), 200);
    }

    #[test]
    fn ocs_wire_format_matches_ocs_5_2_1() {
        use crate::types::{QueryData, QueryRequest, QueryResponse};

        // 请求：POST JSON，字段 title/options/type/images（旧配置没有 images）
        let sent = r#"{"title":"观察下图 [图片1] ","options":"A. 甲\nB. 乙","type":"single","images":["data:image/png;base64,AAAA"]}"#;
        let req: QueryRequest = serde_json::from_str(sent).expect("OCS request must deserialize");
        assert_eq!(req.title, "观察下图 [图片1] ");
        assert_eq!(req.options.as_deref(), Some("A. 甲\nB. 乙"));
        assert_eq!(req.query_type.as_deref(), Some("single"));
        assert_eq!(req.images.len(), 1);
        let legacy: QueryRequest =
            serde_json::from_str(r#"{"title":"t","options":"","type":"unknown"}"#).unwrap();
        assert!(legacy.images.is_empty());

        // 响应：成功 → code=1，data 是单个对象，带 question/answer/is_ai（配置里的 handler 读取这些字段）
        let ok = serde_json::to_value(QueryResponse::success(vec![QueryData {
            id: 7,
            question: "q".to_string(),
            answer: "甲###乙".to_string(),
            is_ai: true,
            is_pending_correction: false,
        }]))
        .unwrap();
        assert_eq!(ok["code"], 1);
        assert!(ok["data"].is_object());
        assert_eq!(ok["data"]["answer"], "甲###乙");
        assert_eq!(ok["data"]["is_ai"], true);

        // 响应：失败/未找到 → code=0 且带 message（handler: res.code === 0 ? [res.message, undefined]）
        let err = serde_json::to_value(QueryResponse::error("错误: 未选择模型".to_string())).unwrap();
        assert_eq!(err["code"], 0);
        assert_eq!(err["message"], "错误: 未选择模型");
    }
    #[test]
    fn request_log_body_omits_large_data_urls_but_keeps_http_urls() {
        use super::request_body_for_log;
        use crate::types::QueryRequest;

        let big = format!("data:image/png;base64,{}", "A".repeat(5000));
        let request = QueryRequest {
            title: "如图所示".to_string(),
            options: None,
            query_type: None,
            images: vec![big, "https://example.com/a.png".to_string()],
        };
        let body = request_body_for_log(&request);
        assert!(body.len() < 400, "log body should be small, got {}", body.len());
        assert!(body.contains("https://example.com/a.png"));
        assert!(body.contains("image/png"));
        assert!(!body.contains("AAAAAAAA"));
    }

    #[test]
    fn truncate_chars_never_splits_multibyte_text() {
        let text = "传动角".repeat(60);
        assert_eq!(truncate_chars(&text, 100).chars().count(), 100);
        assert_eq!(truncate_chars("短文本", 100), "短文本");
    }

    #[test]
    fn long_chinese_plain_text_answer_does_not_panic() {
        let text = "凸轮机构中从动件运动规律取决于凸轮轮廓曲线的形状".repeat(4);
        assert_eq!(extract_answer_from_json(&text), text);
        let labelled = format!("答案：{}", text);
        assert_eq!(extract_answer_from_json(&labelled), text);
    }

    #[test]
    fn same_question_result_tolerates_reversed_braces() {
        assert_eq!(parse_same_question_result("} oops {"), None);
        assert_eq!(parse_same_question_result("{ no closing"), None);
    }

    #[test]
    fn parses_same_true_with_matched_id() {
        assert_eq!(
            parse_same_question_result(r#"{"same":true,"matched_id":42}"#),
            Some(42)
        );
        assert_eq!(
            parse_same_question_result("答案如下\n{\"same\": true, \"matched_id\": 7}\n"),
            Some(7)
        );
    }

    #[test]
    fn parses_same_false_or_invalid_as_none() {
        assert_eq!(parse_same_question_result(r#"{"same":false}"#), None);
        assert_eq!(parse_same_question_result("错误: 未选择模型"), None);
        assert_eq!(parse_same_question_result(""), None);
    }

    #[test]
    fn no_model_selected_is_400_not_500() {
        let (status, msg) = classify_model_failure("错误: 未选择模型").expect("classified");
        assert_eq!(status, 400);
        assert_eq!(msg, "错误: 未选择模型");
    }
}
