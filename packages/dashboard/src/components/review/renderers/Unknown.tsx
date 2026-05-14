/**
 * Unknown — fallback renderer for trace names `detectSource`
 * doesn't recognise. Surfaces input + output via HumanValue
 * (NEVER as raw JSON) so the reviewer still gets something readable.
 */
import { HumanValue } from '../HumanValue'
import type { Renderer } from '../types'

export const UnknownRenderer: Renderer = ({ input, output }) => ({
  input: <HumanValue value={input} />,
  output: <HumanValue value={output} />,
})
