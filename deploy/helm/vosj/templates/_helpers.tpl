{{/*
_helpers.tpl — naming, labels, env, and secret-resolution helpers for the Vosj chart.
*/}}

{{/* Expand the name of the chart. */}}
{{- define "vosj.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name (<release>-<chart>), truncated for the 63-char DNS limit. */}}
{{- define "vosj.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Chart name and version label value. */}}
{{- define "vosj.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "vosj.labels" -}}
helm.sh/chart: {{ include "vosj.chart" . }}
{{ include "vosj.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels (immutable subset). */}}
{{- define "vosj.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vosj.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* ConfigMap name. */}}
{{- define "vosj.configMapName" -}}
{{- printf "%s-config" (include "vosj.fullname" .) -}}
{{- end -}}

{{/* The Secret name in effect — either the chart-managed one or an existing reference. */}}
{{- define "vosj.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- printf "%s-secret" (include "vosj.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Image reference. */}}
{{- define "vosj.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/*
Container env block — shared by the Deployment and the migration Job so they boot
the same config + secrets. Non-secret values come from the ConfigMap; secrets are
mounted by key from the resolved Secret (fail-closed: keys may be empty until set).
*/}}
{{- define "vosj.env" -}}
- name: VOSJ_PORT
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: VOSJ_PORT
- name: VOSJ_STATE_STORE
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: VOSJ_STATE_STORE
- name: VOSJ_AUTH_MODE
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: VOSJ_AUTH_MODE
- name: VOSJ_BASELINE_MAX_AGE_MS
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: VOSJ_BASELINE_MAX_AGE_MS
- name: PG_HOST
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: PG_HOST
- name: PG_PORT
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: PG_PORT
- name: PG_USER
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: PG_USER
- name: PG_DATABASE
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: PG_DATABASE
- name: VOSJ_DB_SSL_REJECT_UNAUTHORIZED
  valueFrom:
    configMapKeyRef:
      name: {{ include "vosj.configMapName" . }}
      key: VOSJ_DB_SSL_REJECT_UNAUTHORIZED
- name: PG_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "vosj.secretName" . }}
      key: {{ .Values.secret.keys.pgPassword }}
- name: VOSJ_LEDGER_HMAC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "vosj.secretName" . }}
      key: {{ .Values.secret.keys.ledgerHmacKey }}
- name: VOSJ_VAULT_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "vosj.secretName" . }}
      key: {{ .Values.secret.keys.vaultMasterKey }}
- name: VOSJ_AUTH_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "vosj.secretName" . }}
      key: {{ .Values.secret.keys.authToken }}
{{- end -}}
