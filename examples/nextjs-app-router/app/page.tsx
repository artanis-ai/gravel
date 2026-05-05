import OpenAI from 'openai'
// Boots Gravel's tracing on import. Once v1 ships, this OpenAI call below
// will produce a trace in your /admin/ai dashboard.
import '@artanis-ai/gravel/auto'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export default async function Home() {
  const reply = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a brief, friendly assistant.' },
      { role: 'user', content: 'Say hi to a Gravel user.' },
    ],
  })

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Gravel Next.js example</h1>
      <p>Dashboard mounted at <a href="/admin/ai">/admin/ai</a>.</p>
      <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 8, overflow: 'auto' }}>
        {reply.choices[0]?.message.content}
      </pre>
    </main>
  )
}
