<script setup lang="ts">
type Answer = { rohan: { riding: number; days: number } }

const SPEARS = [500, 2000, 6000, 9000].map(value => ({ label: `${value.toLocaleString('en')} spears`, value }))

const spears = ref(2000)
const word = ref('')
const isAsking = ref(false)
const ride = useRide()

const send = async () => {
  isAsking.value = true

  try {
    // A refusal is an answer too, and is read like one
    const answer = await $fetch<Answer>(`/api/realm/muster?spears=${spears.value}`, { method: 'POST', ignoreResponseError: true })

    word.value = `${answer.rohan.riding.toLocaleString('en')} spears ride. They come in ${answer.rohan.days} days.`
    ride.value = { ...answer.rohan }
  } finally {
    isAsking.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-lg tracking-wide text-highlighted">The Red Arrow</h2>
    </template>

    <form class="space-y-4" @submit.prevent="send">
      <UFormField label="Spears to ask of Rohan" help="The Mark can put 6,000 in the saddle.">
        <USelect v-model="spears" :items="SPEARS" class="w-48" />
      </UFormField>

      <UButton type="submit" label="Send the Red Arrow" icon="i-lucide-send" :loading="isAsking" />
    </form>

    <UAlert
      class="mt-4"
      variant="subtle"
      :color="word === '' ? 'neutral' : 'success'"
      :icon="word === '' ? 'i-lucide-hourglass' : 'i-lucide-swords'"
      :title="word === '' ? 'Rohan will answer, if Théoden does not hesitate' : 'Rohan answers'"
      :description="word || undefined"
    />
  </UCard>
</template>
