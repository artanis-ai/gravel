export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

export const metadata = {
  title: 'Gravel Next.js example',
  description: 'Demonstrates @artanis-ai/gravel inside a Next.js App Router app.',
}
