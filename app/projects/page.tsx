import type { Metadata } from "next"
import { Navbar } from "@/components/navbar"
import { getProjects, ProjectEntry } from "@/lib/contentful"
import { Github } from "lucide-react"

export const metadata: Metadata = {
  title: "Projects | Jonathan Segovia",
  description: "Portfolio of projects by Jonathan Segovia",
}

export const revalidate = 86400 // Revalidate every 24 hours

export default async function ProjectsPage() {
  let projects: ProjectEntry[] = []
  let error = null

  try {
    projects = await getProjects()
  } catch (err) {
    console.error("Failed to fetch projects:", err)
    error = "Failed to load project data. Please check your Contentful configuration."
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-12">
        <div className="terminal-container max-w-4xl mx-auto">
          <div className="terminal-header">
            <h1 className="terminal-title">Projects</h1>
          </div>

          <div className="terminal-line">
            <span className="terminal-command">$ ls -la projects/</span>
          </div>

          {error ? (
            <div className="mt-8 p-4 border border-red-500/30 bg-red-500/10 text-red-400 rounded">
              <p>{error}</p>
              <p className="mt-2 text-sm">
                Make sure you've set up the required environment variables:
                <ul className="list-disc list-inside mt-1">
                  <li>CONTENTFUL_SPACE_ID</li>
                  <li>CONTENTFUL_ACCESS_TOKEN</li>
                  <li>CONTENTFUL_ENVIRONMENT (optional)</li>
                </ul>
              </p>
            </div>
          ) : projects.length === 0 ? (
            <div className="mt-8 p-4 border border-terminal-green/30 rounded">
              <p>No projects found. Add some content in your Contentful space.</p>
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {projects.map((project, index) => (
                <div key={index} className="border border-terminal-green/30 rounded p-6 bg-terminal-black/30">
                  <h2 className="text-2xl font-bold mb-3">{project.name}</h2>
                  <p className="text-terminal-green/90 mb-4">{project.description}</p>
                  
                  {project.skills.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      {project.skills.map((skill, idx) => (
                        <span
                          key={idx}
                          className="text-xs px-2 py-1 bg-terminal-black border border-terminal-green/30 rounded"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>
                  )}
                  
                  {project.githubUrl && (
                    <div className="mt-3">
                      <a 
                        href={project.githubUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-terminal-green hover:text-white flex items-center gap-2 w-fit"
                      >
                        <Github size={16} />
                        <span>View on GitHub</span>
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
