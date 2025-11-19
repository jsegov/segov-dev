import Link from "next/link"
import { Navbar } from "@/components/navbar"

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 container mx-auto px-4 py-12 flex flex-col justify-center items-center">
        <div className="terminal-container max-w-3xl w-full">
          <pre className="text-primary/foreground text-center mb-6 text-xs sm:text-sm md:text-base">
            {`
  _____                                          _   _   _       _     ______                       _ 
 / ____|                                        | | | \\ | |     | |   |  ____|                     | |
| |     ___  _ __ ___  _ __ ___   __ _ _ __   __| | |  \\| | ___ | |_  | |__ ___  _   _ _ __   __| |
| |    / _ \\| '_ \` _ \\| '_ \` _ \\ / _\` | '_ \\ / _\` | | . \` |/ _ \\| __| |  __/ _ \\| | | | '_ \\ / _\` |
| |___| (_) | | | | | | | | | | | (_| | | | | (_| | | |\\  | (_) | |_  | | | (_) | |_| | | | | (_| |
 \\_____\\___/|_| |_| |_|_| |_| |_|\\__,_|_| |_|\\__,_| |_| \\_|\\___/ \\__| |_|  \\___/ \\__,_|_| |_|\\__,_|
                                                                                                    
`}
          </pre>

          <div className="terminal-line">
            <span className="terminal-command">$ cd /</span>
          </div>
          <div className="terminal-response mb-4">
            <p>The page you are looking for does not exist or has been moved.</p>
          </div>

          <div className="terminal-line">
            <span className="terminal-command">$ ls -la</span>
          </div>
          <div className="terminal-response mb-6">
            <ul className="list-disc list-inside">
              <li>
                <Link href="/" className="underline hover:text-white">
                  Home
                </Link>
              </li>
              <li>
                <Link href="/career" className="underline hover:text-white">
                  Career
                </Link>
              </li>
              <li>
                <Link href="/projects" className="underline hover:text-white">
                  Projects
                </Link>
              </li>
              <li>
                <Link href="/blog" className="underline hover:text-white">
                  Blog
                </Link>
              </li>
              <li>
                <Link href="/ama" className="underline hover:text-white">
                  AMA
                </Link>
              </li>
            </ul>
          </div>

          <div className="terminal-line flex">
            <span className="terminal-command">$</span>
            <span className="blinking-cursor"></span>
          </div>
        </div>
      </div>
    </div>
  )
}
