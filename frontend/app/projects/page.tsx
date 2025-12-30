import type { Metadata } from 'next'
import { Navbar } from '@/components/navbar'
import { getProjects, ProjectEntry } from '@/lib/content'
import { Github, ExternalLink } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Projects | Jonathan Segovia',
  description: 'Portfolio of projects by Jonathan Segovia',
}

export const revalidate = 86400 // Revalidate every 24 hours

export default async function ProjectsPage() {
  let projects: ProjectEntry[] = []
  let error = null

  try {
    projects = await getProjects()
  } catch (err) {
    console.error('Failed to fetch projects:', err)
    error = 'Failed to load project data.'
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
            <div className="mt-8 p-4 border border-destructive/30 bg-destructive/10 text-destructive rounded">
              <p>{error}</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="mt-8 p-4 border border-border/30 rounded">
              <p>No projects found.</p>
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {projects.map((project, index) => (
                <div
                  key={index}
                  className="border border-border/30 rounded p-6 bg-card text-card-foreground"
                >
                  <h2 className="text-2xl font-bold mb-3">{project.name}</h2>
                  <p className="text-muted-foreground mb-4">{project.description}</p>

                  {project.skills.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4">
                      {project.skills.map((skill, idx) => (
                        <span
                          key={idx}
                          className="text-xs px-2 py-1 bg-muted text-muted-foreground border border-border/30 rounded"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-col gap-2">
                    {project.websiteUrl && (
                      <a
                        href={project.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground dark:hover:text-white flex items-center gap-2 w-fit transition-colors"
                      >
                        <ExternalLink size={16} />
                        <span>View Website</span>
                      </a>
                    )}
                    {project.githubUrl && (
                      <a
                        href={project.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground dark:hover:text-white flex items-center gap-2 w-fit transition-colors"
                      >
                        <Github size={16} />
                        <span>View on GitHub</span>
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
