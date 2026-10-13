<template>
  <UApp>
    <UContainer class="max-w-4xl py-10 space-y-5">
      <header class="text-center space-y-1">
        <p class="text-xs uppercase tracking-[0.22em] text-muted">Minas Tirith · the Tower of Guard</p>
        <h1 class="text-4xl sm:text-5xl tracking-wide text-highlighted">The Anor-stone</h1>
        <p class="text-muted">What the Steward sees of the realm tonight.</p>
      </header>

      <BeaconChain />

      <div class="grid gap-5 md:grid-cols-2">
        <SeeingStones />
        <MusterForm />
      </div>
    </UContainer>
  </UApp>
</template>
