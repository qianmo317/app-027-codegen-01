<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { store } from '@/logic/store'
import { ledger, ledgerState } from '@/logic/ledger'

const route = useRoute()

onMounted(() => {
  store.loadState()
  ledger.load()
})

const project = computed(() => {
  const id = route.params.id
  if (typeof id !== 'string') return null
  return store.getProject(id) ?? null
})

const contextLabel = computed(() => {
  if (!project.value) return ''
  return project.value.name
})

const pendingCount = computed(() => ledgerState.entries.filter((e) => e.status === 'pending').length)
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink class="brand" to="/">
        <span class="brand-mark"></span>
        <span>剪纸刻绘刀路生成</span>
        <span class="brand-sub">Paper-cut Plotter Studio</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/">纹样库</RouterLink>
        <RouterLink v-if="project" :to="`/design/${project.id}`">编辑</RouterLink>
        <RouterLink v-if="project" :to="`/layout/${project.id}`">排版</RouterLink>
        <RouterLink v-if="project" :to="`/export/${project.id}`">导出</RouterLink>
        <RouterLink to="/ledger">台账<span v-if="pendingCount" class="nav-badge">{{ pendingCount }}</span></RouterLink>
        <RouterLink to="/materials">材料预设</RouterLink>
        <RouterLink to="/help">上机指南</RouterLink>
      </nav>

      <div class="header-right">
        <span v-if="contextLabel" class="tag accent">{{ contextLabel }}</span>
        <span class="tag ok">离线可用</span>
      </div>
    </header>

    <RouterView />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 0;
}

.nav a {
  position: relative;
}

.nav-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  margin-left: 3px;
  border-radius: 8px;
  background: var(--warn);
  color: #241a02;
  font-size: 10px;
  font-weight: 700;
  vertical-align: top;
}
</style>