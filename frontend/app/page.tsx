import Link from "next/link"
import { Navbar } from "@/components/navbar"
import { Github, Linkedin } from "lucide-react"
import { getAboutMe } from "@/lib/content"

// Custom X logo component
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M13.3174 10.7749L19.1457 4H17.7646L12.7039 9.88256L8.66193 4H4L10.1122 12.8955L4 20H5.38119L10.7254 13.7878L14.994 20H19.656L13.3174 10.7749ZM11.4257 12.9738L10.8064 12.0881L5.87886 5.03974H8.00029L11.9769 10.728L12.5962 11.6137L17.7653 19.0075H15.6439L11.4257 12.9738Z" />
    </svg>
  )
}

export default async function Home() {
  const aboutMe = await getAboutMe() || { 
    description: "my name is jonathan segovia, but some people call me segov. i am currently a swe at jeff bezos' online bookstore where i help automate content publishing at our netflix clone. previously i was a swe at workday where i played ping pong, attended happy hours, and failed at convincing leadership that workday was slow due to it's flawed design. i attended ucsb (aka paradise on earth), where i majored in computer science and minored in binge drinking."
  }
  
  const items = [
    { name: "career", path: "/career", type: "directory" },
    { name: "projects", path: "/projects", type: "directory" },
    { name: "blog", path: "/blog", type: "directory" },
    { name: "ama", path: "/ama", type: "directory" },
  ]

  const socialLinks = [
    {
      name: "GitHub",
      url: "https://github.com/jsegov",
      icon: <Github className="h-5 w-5" />,
    },
    {
      name: "LinkedIn",
      url: "https://linkedin.com/in/jonathansegovia",
      icon: <Linkedin className="h-5 w-5" />,
    },
    {
      name: "X",
      url: "https://x.com/jonsegov",
      icon: <XLogo className="h-5 w-5" />,
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
              <p className="mb-4">
                {aboutMe.description}
              </p>
            </div>

            <div className="terminal-line">
              <span className="terminal-command">$ ls</span>
            </div>
            <div className="terminal-response">
              <div className="font-mono text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {items.map((item) => (
                    <Link key={item.name} href={item.path} className="text-blue-400 hover:underline">
                      {item.name}/
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            <div className="terminal-line">
              <span className="terminal-command">$ find / -name "social_links"</span>
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
