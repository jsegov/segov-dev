"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { useState } from "react"
import { ThemeToggle } from "@/components/theme-toggle"

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
    <nav className="terminal-window-header sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b border-border/30">
      <div className="container mx-auto flex justify-between items-center">
        <div className="flex items-center">
          {/* Removed the colored dots */}
          <span className="font-bold text-foreground">{getTerminalPrompt()}</span>
        </div>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center space-x-6">
          {navItems.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={`nav-link ${pathname === item.path ? "text-foreground font-bold" : "text-muted-foreground"}`}
            >
              {item.name}
            </Link>
          ))}
          <ThemeToggle />
        </div>

        {/* Mobile Navigation Toggle */}
        <div className="flex items-center md:hidden gap-4">
          <ThemeToggle />
          <button className="text-foreground" onClick={() => setIsMenuOpen(!isMenuOpen)}>
            {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Menu */}
      {isMenuOpen && (
        <div className="md:hidden absolute top-full left-0 right-0 bg-background border-t border-border/30 py-4 shadow-lg">
          <div className="container mx-auto flex flex-col space-y-4 px-4">
            {navItems.map((item) => (
              <Link
                key={item.path}
                href={item.path}
                className={`nav-link ${pathname === item.path ? "text-foreground font-bold" : "text-muted-foreground"}`}
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
