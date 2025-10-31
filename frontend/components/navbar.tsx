"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { useState } from "react"

const navItems = [
  { name: "Home", path: "/" },
  { name: "Career", path: "/career" },
  { name: "Projects", path: "/projects" },
  { name: "Blog", path: "/blog" },
  { name: "AMA", path: "/ama" },
]

export function Navbar() {
  const pathname = usePathname()
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  // Format the terminal prompt based on current path
  const getTerminalPrompt = () => {
    if (pathname === "/") {
      return "~/segov/:$"
    }

    // Remove the leading slash and get the first segment of the path
    const pathSegment = pathname.substring(1).split("/")[0]
    return `~/segov/${pathSegment}:$`
  }

  return (
    <nav className="terminal-window-header sticky top-0 z-10">
      <div className="container mx-auto flex justify-between items-center">
        <div className="flex items-center">
          {/* Removed the colored dots */}
          <span className="font-bold">{getTerminalPrompt()}</span>
        </div>

        {/* Desktop Navigation */}
        <div className="hidden md:flex space-x-6">
          {navItems.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={`nav-link ${pathname === item.path ? "text-white" : "text-terminal-text/80"}`}
            >
              {item.name}
            </Link>
          ))}
        </div>

        {/* Mobile Navigation Toggle */}
        <button className="md:hidden text-terminal-text" onClick={() => setIsMenuOpen(!isMenuOpen)}>
          {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile Navigation Menu */}
      {isMenuOpen && (
        <div className="md:hidden absolute top-full left-0 right-0 bg-terminal-black border-t border-terminal-text/30 py-4">
          <div className="container mx-auto flex flex-col space-y-4">
            {navItems.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                className={`nav-link ${pathname === item.path ? "text-white" : "text-terminal-text/80"}`}
                onClick={() => setIsMenuOpen(false)}
              >
                {item.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  )
}
