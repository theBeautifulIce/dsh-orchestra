// DSH v4 uses the producer as the source kind. Its v3 upgrader assigns this
// same kind to messages previously written as { kind: 'plugin', plugin: 'dsh-orchestra' }.
export const ORCHESTRA_MESSAGE_SOURCE = 'plugin:dsh-orchestra'
