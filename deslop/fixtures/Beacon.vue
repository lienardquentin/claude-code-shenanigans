<template>
  <!-- light the beacon -->
  <p>{{ beacon }}</p>
</template>

<script setup lang="ts">
// light the beacon
const beacon = lightBeacon()
const data = beacon.data
</script>
