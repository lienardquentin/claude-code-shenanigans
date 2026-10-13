{{/* The labels every object carries; `realm` is the name of the one it belongs to */}}
{{- define "beacons.labels" -}}
app.kubernetes.io/name: {{ .realm }}
app.kubernetes.io/part-of: beacons
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end }}

{{/* What a Deployment picks its pods by, and a Service its endpoints */}}
{{- define "beacons.selector" -}}
app.kubernetes.io/name: {{ .realm }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}
