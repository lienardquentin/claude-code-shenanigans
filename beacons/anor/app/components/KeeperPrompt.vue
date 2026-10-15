<script setup lang="ts">
// Opened through useKeeperPrompt: it closes with the name given (empty for no one in particular), or false when called off
const props = defineProps<{ beacon: string; keeper: string }>()
const emit = defineEmits<{ close: [keeper: string | false] }>()

const name = ref(props.keeper)
</script>

<template>
  <UModal :title="`Who lights ${named(beacon)}?`" description="The name goes with the fire, to Rohan and into the chronicle. Leave it empty to light it unnamed.">
    <template #body>
      <form id="keeper-prompt" @submit.prevent="emit('close', name.trim())">
        <UFormField label="Keeper">
          <!-- Gondor refuses a name longer than 64 characters -->
          <UInput v-model="name" placeholder="Hirgon" autofocus autocomplete="name" :maxlength="64" class="w-full" />
        </UFormField>
      </form>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="emit('close', false)" />
        <UButton type="submit" form="keeper-prompt" label="Light" icon="i-lucide-flame" />
      </div>
    </template>
  </UModal>
</template>
