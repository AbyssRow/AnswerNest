use std::path::{Path, PathBuf};

static CONFIG_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub(crate) fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        windows_data_dir(std::env::var_os("LOCALAPPDATA"), std::env::var_os("USERPROFILE"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into()))
            .join(".local/share/answernest")
    }
}

#[cfg(any(windows, test))]
fn windows_data_dir(local: Option<std::ffi::OsString>, profile: Option<std::ffi::OsString>) -> PathBuf {
    local.filter(|value| !value.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(profile.unwrap_or_else(|| ".".into())).join("AppData/Local"))
        .join("AnswerNest")
}

pub(crate) fn read_config_file(name: &str) -> Result<String, String> {
    let target = data_dir().join(name);
    // 定位不到 exe 目录只是无法迁移旧配置，不能连已有的配置也读不出来；空路径不是文件，会被跳过
    let legacy = std::env::current_exe().ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_default();
    read_config_from(&target, &legacy)
}

fn read_config_from(target: &Path, legacy: &Path) -> Result<String, String> {
    let _guard = CONFIG_LOCK.lock();
    if target.exists() {
        return std::fs::read_to_string(target).map_err(|error| error.to_string());
    }
    // Older builds kept configuration next to the executable. Copy it once, preserving the original.
    if !legacy.is_file() { return Ok(String::new()); }
    let content = std::fs::read_to_string(legacy).map_err(|error| error.to_string())?;
    write_file_atomic_unlocked(target, &content)?;
    Ok(content)
}

pub(crate) fn write_config_file(name: &str, content: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(content).map_err(|error| error.to_string())?;
    write_file_atomic(&data_dir().join(name), content)
}

fn write_file_atomic(path: &Path, content: &str) -> Result<(), String> {
    // Serialize replacements, and never share a temporary filename across concurrent saves.
    let _guard = CONFIG_LOCK.lock();
    write_file_atomic_unlocked(path, content)
}

fn write_file_atomic_unlocked(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("配置文件没有父目录")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".config-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_config_once_without_overwriting_current_settings() {
        let directory = std::env::temp_dir().join(format!("answernest-migration-test-{}", uuid::Uuid::new_v4()));
        let legacy = directory.join("old/config.json");
        let target = directory.join("data/config.json");
        assert_eq!(read_config_from(&target, &legacy).unwrap(), "");
        write_file_atomic(&legacy, "{\"port\":3000}").unwrap();
        assert_eq!(read_config_from(&target, &legacy).unwrap(), "{\"port\":3000}");
        assert!(legacy.exists());
        write_file_atomic(&target, "{\"port\":4000}").unwrap();
        assert_eq!(read_config_from(&target, &legacy).unwrap(), "{\"port\":4000}");
        for file in [&legacy, &target] { std::fs::remove_file(file).unwrap(); }
        for folder in [directory.join("old"), directory.join("data"), directory] { std::fs::remove_dir(folder).unwrap(); }
    }

    #[test]
    fn respects_windows_profile_locations() {
        assert_eq!(windows_data_dir(Some("D:/Profiles/User/Local".into()), None), PathBuf::from("D:/Profiles/User/Local/AnswerNest"));
        assert_eq!(windows_data_dir(None, Some("D:/Profiles/OldName".into())), PathBuf::from("D:/Profiles/OldName/AppData/Local/AnswerNest"));
    }

    #[test]
    fn concurrent_config_saves_leave_one_complete_document() {
        let directory = std::env::temp_dir().join(format!("answernest-storage-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("config.json");
        write_file_atomic(&path, "{}").unwrap();
        std::thread::scope(|scope| {
            for n in 0..16 {
                let path = &path;
                scope.spawn(move || write_file_atomic(path, &serde_json::json!({"n": n, "text": "x".repeat(8192)}).to_string()).unwrap());
            }
        });
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["text"].as_str().unwrap().len(), 8192);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
