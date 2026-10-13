<script setup lang="ts">
const { beacons, error, refresh, light, quench } = useBeacons()

const litCount = computed(() => beacons.value.filter(({ lit }) => lit).length)

// The riders light beacons too: the chain is looked at again every few seconds
let watch: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  watch = setInterval(() => void refresh(), 3000)
})
onBeforeUnmount(() => clearInterval(watch))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <h2 class="text-lg tracking-wide text-highlighted">The beacons</h2>
          <UBadge :color="litCount > 0 ? 'primary' : 'neutral'" variant="subtle" :label="`${litCount} of ${beacons.length} lit`" />
        </div>
        <UButton label="Quench them" icon="i-lucide-moon" color="neutral" variant="ghost" size="sm" @click="quench" />
      </div>
    </template>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" title="Gondor does not answer" class="mb-4" />

    <ol class="grid grid-cols-7 gap-1">
      <li v-for="{ beacon, lit } in beacons" :key="beacon">
        <UButton
          color="neutral"
          variant="ghost"
          block
          :aria-pressed="lit"
          :aria-label="`Light ${named(beacon)}`"
          class="flex-col gap-1 px-0"
          :class="{ lit }"
          @click="light(beacon)"
        >
          <span class="fire size-3.5 rounded-full" aria-hidden="true" />
          <span class="peak w-full h-9 sm:h-12" aria-hidden="true" />
          <span class="text-[0.62rem] sm:text-xs wrap-anywhere" :class="lit ? 'text-primary' : 'text-muted'">{{ named(beacon) }}</span>
        </UButton>
      </li>
    </ol>

    <template #footer>
      <p class="text-sm italic text-muted">Light a beacon, east to west. The riders light them too.</p>
    </template>
  </UCard>
</template>
