<script setup lang="ts">
const { data: stones } = await useFetch<string[]>('/api/realm/palantiri', { default: () => [] })
const { gazed, vision, isDark, isGazing, gaze } = useStones()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-lg tracking-wide text-highlighted">The seeing-stones</h2>
    </template>

    <div class="flex flex-wrap gap-2">
      <!-- Osgiliath's stone was lost in the river: it is offered all the same, and Gondor says so -->
      <UButton
        v-for="stone in [...stones, 'osgiliath']"
        :key="stone"
        :label="named(stone)"
        icon="i-lucide-eye"
        class="rounded-full"
        :color="gazed === stone ? 'primary' : 'neutral'"
        :variant="gazed === stone ? 'soft' : 'outline'"
        :loading="isGazing && gazed === stone"
        @click="gaze(stone)"
      />
    </div>

    <UAlert
      class="mt-4"
      variant="subtle"
      :color="gazed === '' ? 'neutral' : isDark ? 'error' : 'primary'"
      :icon="gazed === '' ? 'i-lucide-circle-dashed' : isDark ? 'i-lucide-eye-off' : 'i-lucide-sparkles'"
      :title="gazed === '' ? 'Choose a stone to look into' : isDark ? `The ${named(gazed)}-stone is dark` : `In the ${named(gazed)}-stone you see`"
      :description="gazed === '' ? undefined : vision"
    />
  </UCard>
</template>
