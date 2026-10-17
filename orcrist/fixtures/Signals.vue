<script lang="ts">export const data = loadSignals()</script>

<template>
  <!-- <script>const tmp = 1</script> -->
  <p>{{ shown }}</p>
</template>

<script setup generic="T extends Map<string, number>" lang="tsx">
// show the beacon
const shown = showBeacon()
const view = () => <p>{shown}</p>
const tmp = view()
</script>
