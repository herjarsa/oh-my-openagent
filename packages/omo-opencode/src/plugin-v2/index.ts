export { createV2SpikeSetup } from "./setup"
export { translateAgentToV2Draft } from "./translate-agent"
export type { V2AgentDraft } from "./translate-agent"

import { createV2SpikeSetup } from "./setup"

export const omoV2Plugin = createV2SpikeSetup()

export default omoV2Plugin
