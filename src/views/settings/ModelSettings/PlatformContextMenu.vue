<template>
  <UnifiedContextMenu
    :visible="visible"
    :x="x"
    :y="y"
    :menu-items="menuItems"
    exclusive-key="platform-context-menu"
    @item-click="handleItemClick"
    @close="$emit('close')"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import UnifiedContextMenu, { type MenuItem } from '../../../components/UnifiedContextMenu.vue'
import type { AIPlatform } from '../../../services/modelConfig'

interface Props {
  visible: boolean
  x: number
  y: number
  platform?: AIPlatform | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'edit-platform': []
  'delete-platform': []
  close: []
}>()

const menuItems = computed<MenuItem[]>(() => {
  return [
    {
      id: 'edit-platform',
      label: '编辑平台',
      action: 'edit-platform',
      icon: {
        type: 'svg',
        paths: [
          { d: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7' },
          { d: 'M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z' }
        ]
      }
    },
    { type: 'divider' },
    {
      id: 'delete-platform',
      label: '删除平台',
      action: 'delete-platform',
      danger: true,
      icon: {
        type: 'svg',
        polylines: [{ points: '3,6 5,6 21,6' }],
        paths: [{ d: 'M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2' }]
      }
    }
  ]
})

const handleItemClick = (item: MenuItem) => {
  switch (item.action) {
    case 'edit-platform':
      emit('edit-platform')
      break
    case 'delete-platform':
      emit('delete-platform')
      break
  }
}
</script>
