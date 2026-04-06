import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'

// Force dynamic rendering to avoid Clerk prerender errors during build
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Financial Chatbot',
  description: 'AI-powered financial data analysis for construction projects',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="font-sans">{children}</body>
      </html>
    </ClerkProvider>
  )
}
