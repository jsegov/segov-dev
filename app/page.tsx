import Link from 'next/link'
import { connection } from 'next/server'
import { Navbar } from '@/components/navbar'
import { Github } from 'lucide-react'
import { getAboutMe } from '@/lib/content'

export default async function Home() {
  await connection()

  let aboutMe = null
  let error: string | null = null

  try {
    aboutMe = await getAboutMe()
  } catch (err) {
    console.error('Failed to fetch about content:', err)
    error = 'Failed to load about data.'
  }

  const items = [
    { name: 'career', path: '/career', type: 'directory' },
    { name: 'projects', path: '/projects', type: 'directory' },
    { name: 'blog', path: '/blog', type: 'directory' },
    { name: 'ama', path: '/ama', type: 'directory' },
  ]

  const socialLinks = [
    {
      name: 'GitHub',
      url: 'https://github.com/jsegov',
      icon: <Github className="h-5 w-5" />,
    },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-12 flex flex-col justify-center">
        <div className="terminal-container max-w-3xl mx-auto">
          <div className="space-y-6">
            <div className="terminal-line">
              <span className="terminal-command">$ whoami</span>
            </div>
            <div className="terminal-response">
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-4">Jonathan Segovia</h1>
              <p className="text-lg md:text-xl opacity-80 mb-6">Software Engineer</p>
            </div>

            <div className="terminal-line">
              <span className="terminal-command">$ cat about.txt</span>
            </div>
            <div className="terminal-response">
              {error ? (
                <div className="p-4 border border-destructive/30 bg-destructive/10 text-destructive rounded">
                  <p>{error}</p>
                </div>
              ) : (
                <p className="mb-4">{aboutMe?.description}</p>
              )}
            </div>

            <div className="terminal-line">
              <span className="terminal-command">$ ls</span>
            </div>
            <div className="terminal-response">
              <div className="font-mono text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {items.map((item) => (
                    <Link
                      key={item.name}
                      href={item.path}
                      className="text-blue-400 hover:underline"
                    >
                      {item.name}/
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            <div className="terminal-line">
              <span className="terminal-command">$ find / -name &quot;social_links&quot;</span>
            </div>
            <div className="terminal-response">
              <div className="font-mono text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {socialLinks.map((link) => (
                    <a
                      key={link.name}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline flex items-center"
                      aria-label={link.name}
                    >
                      {link.icon}
                      <span>/</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>

            <div className="terminal-line flex">
              <span className="terminal-command">$</span>
              <span className="blinking-cursor"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
