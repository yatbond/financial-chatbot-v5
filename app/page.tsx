'use client'

import { useState, useEffect, useRef } from 'react'
import { Send, Bot, User, FileSpreadsheet, Loader2, Calendar, Building2, ChevronDown, ChevronRight, Plus, BookOpen } from 'lucide-react'
import { UserButton, useUser, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs"

// Format number for summary panel - abbreviate large numbers
// IMPORTANT: Data values are in thousands ('000), so:
// - A value of 70549.9 means 70,549,900 actual dollars = 70.5 million
// - We MUST divide by 1000 to convert from thousands to millions
// - NEVER multiply values anywhere in the chain
// - formatSummaryNumber receives values in THOUSANDS and converts to display format
function formatSummaryNumber(value: number | string): string {
  // If it's a percentage string, format with one decimal place
  if (typeof value === 'string' && value.includes('%')) {
    const num = parseFloat(value.replace('%', ''))
    if (!isNaN(num)) {
      return `${num.toFixed(1)}%`
    }
    return value
  }
  
  // If it's a date string, return as-is
  if (typeof value === 'string') return value
  
  const absValue = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  
  // Data is in thousands ('000), so we need to convert to display format:
  // - Values >= 1000000 (thousands) = 1 billion+ actual → display as "B" (divide by 1e6)
  // - Values >= 1000 (thousands) = 1 million+ actual → display as "Mil" (divide by 1000)
  // - Values >= 1 (thousands) = 1000+ actual → display as "K" (no division)
  // - Values < 1 (thousands) = less than 1000 actual → display as "K" (no division)
  // 
  // Example: 70549.9 (thousands) = 70,549,900 actual = 70.5 million
  // → 70549.9 >= 1000, so divide by 1000 = 70.5 Mil
  if (absValue >= 1e6) {
    // 1,000,000 thousand = 1 billion actual
    return `${sign}${(absValue / 1e6).toFixed(1)} B`
  } else if (absValue >= 1000) {
    // 1,000 thousand = 1 million actual
    return `${sign}${(absValue / 1000).toFixed(1)} Mil`
  }
  // Less than 1000 thousand = less than 1 million actual
  return `${sign}${absValue.toFixed(1)} K`
}

// Format currency for chat messages
function formatCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  candidates?: Candidate[]
  debugData?: any
}

// Helper to bold all dollar amounts in text (supports negative: $-1,234)
function boldDollars(text: string) {
  return text.split(/(\$-?\d+(?:,\d+)*(?:\.\d+)?)/g).map((part, j) => 
    part.startsWith('$') ? <span key={j} className="font-bold text-base">{part}</span> : part
  )
}

interface Candidate {
  id: number
  value: number
  score: number
  sheet: string
  financialType: string
  dataType: string
  itemCode: string
  month: string
  year: string
}

interface ProjectInfo {
  code: string
  name: string
  year: string
  month: string
  filename: string
}

interface FolderStructure {
  [year: string]: string[]
}

interface Metrics {
  'Business Plan GP': number
  'Projected GP': number
  'WIP GP': number
  'Cash Flow': number
  'Start Date': string
  'Complete Date': string
  'Target Complete Date': string
  'Time Consumed (%)': string
  'Target Completed (%)': string
}

// Component to render message with inline candidate buttons
function CandidateMessage({ content, candidates, onSelect }: { 
  content: string
  candidates: Candidate[]
  onSelect: (e: React.MouseEvent, candidate: Candidate) => void 
}) {
  const lines = content.split('\n')
  
  return (
    <div className="whitespace-pre-wrap text-sm">
      {lines.map((line, i) => {
        const match = line.match(/^\[(\d+)\]/)
        if (match) {
          const num = parseInt(match[1])
          const candidate = candidates.find(c => c.id === num)
          if (candidate) {
            return (
              <div key={i} className="flex items-center gap-2 py-1">
                <button
                  onClick={(e) => onSelect(e, candidate)}
                  className="flex items-center gap-1.5 px-2 py-1 bg-blue-500/20 hover:bg-blue-500/40 border border-blue-500/50 rounded text-xs text-blue-300 transition-colors min-w-[50px]"
                >
                  <span className="font-bold">[{num}]</span>
                </button>
                <span className="flex-1">{boldDollars(line.replace(match[0], ''))}</span>
              </div>
            )
          }
        }
        return <div key={i}>{boldDollars(line)}</div>
      })}
    </div>
  )
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: "👋 Welcome to Financial Chatbot v5!\n\n**Commands:**\n• `analyze` — Run financial analysis (6 comparisons)\n• `detail X` — Drill down into results\n• `compare X vs Y` — Compare two Financial Types\n• `total [item] [type]` — Sum all sub-items\n• `list` — Show all data items\n• `trend [metric] [months]` — Show trends over time\n• `risk` — Risk items across WIP/Committed/CF\n• `cash flow` — Last 12 months GP summary\n• `type` — List all Financial Types\n• `shortcuts` — Full help with all shortcuts\n\n**Financial Types:**\n• `bp` → Business Plan\n• `budget`/`bt` → Latest Budget\n• `1wb` → 1st Working Budget\n• `tender` → Budget Tender\n• `projection`/`projected` → Projection\n• `wip`/`audit` → WIP\n• `committed` → Committed Cost\n• `revision`/`rev` → Latest Budget (same)\n• `cf`/`cashflow` → Cash Flow\n• `accrual` → Accrual\n\n**Data Types:**\n• `gp` → Gross Profit\n• `np` → Net Profit\n• `prelim` → Preliminaries\n• `materials` → Materials\n• `plant` → Plant & Machinery\n• `subcon` → Subcontractor\n\nType `shortcuts` for full help." }
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingProject, setIsLoadingProject] = useState(false)

  const [folders, setFolders] = useState<FolderStructure>({})
  const [projects, setProjects] = useState<Record<string, ProjectInfo>>({})
  const [selectedYear, setSelectedYear] = useState('')
  const [selectedMonth, setSelectedMonth] = useState('')
  const [availableProjects, setAvailableProjects] = useState<ProjectInfo[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [selectedFile, setSelectedFile] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [showFilters, setShowFilters] = useState(true) // Default to expanded
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showAcronyms, setShowAcronyms] = useState(false)
  const [debugData, setDebugData] = useState<any>(null)

  const [guideTab, setGuideTab] = useState<'commands' | 'financial' | 'data'>('commands')

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { loadStructure() }, [])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    if (selectedYear && selectedMonth) {
      const filtered = Object.values(projects).filter(p => p.year === selectedYear && p.month === selectedMonth)
      setAvailableProjects(filtered)
      setSelectedProject('')
      setSelectedFile('')
      setMetrics(null)
      setDebugData(null)
      setShowDiagnostics(false)
    }
  }, [selectedYear, selectedMonth, projects])

  const loadStructure = async () => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getStructure' })
      })
      const data = await res.json()
      
      if (data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ **Error:** ${data.error}` }])
      }
      
      setFolders(data.folders)
      setProjects(data.projects)

      const years = Object.keys(data.folders || {}).sort().reverse()
      if (years.length > 0) {
        setSelectedYear(years[0])
        const months = data.folders[years[0]].sort((a: string, b: string) => parseInt(b) - parseInt(a))
        if (months.length > 0) setSelectedMonth(months[0])
      } else if (!data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ No data found. Check folder sharing.' }])
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ **Connection Error:** ${error}` }])
    } finally {
      setIsLoading(false)
    }
  }

  const loadProjectData = async (file: string, projectName: string) => {
    if (!selectedYear || !selectedMonth) return

    setIsLoadingProject(true)
    setMessages(prev => [...prev, { role: 'assistant', content: `⏳ Loading **${projectName}**...` }])
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'loadProject', year: selectedYear, month: selectedMonth, project: projectName, projectFile: file })
      })
      const response = await res.json()
      
      setMetrics(response.metrics)
      setDebugData(response.debug)
      setShowFilters(true) // Keep filters expanded
      setShowDiagnostics(false) // Diagnostics collapsed by default
      setSelectedProject(projectName)
      setSelectedFile(file)

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `✅ **${projectName}**\n\n📊 Key Metrics ('000):\n• BP GP: ${formatCurrency(response.metrics['Business Plan GP'])}\n• Proj GP: ${formatCurrency(response.metrics['Projected GP'])}\n• WIP GP: ${formatCurrency(response.metrics['WIP GP'])}\n• Cash Flow: ${formatCurrency(response.metrics['Cash Flow'])}`
      }])
    } catch (error) {
      console.error('Error loading project:', error)
    } finally {
      setIsLoadingProject(false)
    }
  }

  const handleCandidateSelect = async (e: React.MouseEvent, candidate: Candidate) => {
    if (!selectedProject) return
    const userMessage = `[${candidate.id}] Selected: ${candidate.sheet}/${candidate.financialType}/${candidate.dataType}/${candidate.itemCode} (${candidate.month}) = ${formatCurrency(candidate.value)}`
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: `✅ **Selected:**\n\n• Sheet: ${candidate.sheet}\n• Financial Type: ${candidate.financialType}\n• Data Type: ${candidate.dataType}\n• Item Code: ${candidate.itemCode}\n• Month: ${candidate.month}\n• Value: ${formatCurrency(candidate.value)}`
    }])
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const userMessage = input.trim()
    if (!userMessage.trim() || !selectedProject) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'query', year: selectedYear, month: selectedMonth, project: selectedProject, projectFile: selectedFile, question: userMessage })
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.response, candidates: data.candidates || [] }])

      const metricsRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'metrics', year: selectedYear, month: selectedMonth, project: selectedProject, projectFile: selectedFile })
      })
      setMetrics((await metricsRes.json()).metrics)
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Error. Try again.' }])
    }
  }

  const filteredProjects = searchQuery
    ? availableProjects.filter(p => `${p.code} - ${p.name}`.toLowerCase().includes(searchQuery.toLowerCase()))
    : availableProjects

  const handleProjectSelect = (val: string) => {
    setSelectedProject(val)
    setSearchQuery('')
    const found = availableProjects.find(p => `${p.code} - ${p.name}` === val)
    if (found) loadProjectData(found.filename, val)
  }

  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Connecting to Google Drive...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-slate-900 flex flex-col">
      <SignedIn>
        <header className="bg-slate-800 border-b border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="bg-slate-800 p-1 rounded-lg">
                <img src="/logo.png" alt="Logo" className="h-8 w-auto" style={{ objectFit: 'contain' }} />
              </div>
              <h1 className="text-lg font-bold text-white">Financial Bot</h1>
            </div>
            <div className="flex gap-2">
              <UserButton afterSignOutUrl="/" />
              <button
                onClick={() => setShowAcronyms(!showAcronyms)}
                className={`p-2 rounded-lg transition-colors flex items-center gap-1.5 ${showAcronyms ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                title="Function Guide"
              >
                <BookOpen className="w-5 h-5" />
                <span className="text-xs font-medium hidden sm:inline">Guide</span>
              </button>
              <button
                onClick={() => setShowDiagnostics(!showDiagnostics)}
                disabled={!debugData}
                className={`p-2 rounded-lg transition-colors ${debugData ? 'bg-slate-700 hover:bg-slate-600 text-slate-300' : 'bg-slate-800 text-slate-600 cursor-not-allowed'}`}
              >
                <FileSpreadsheet className="w-5 h-5" />
              </button>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`p-2 rounded-lg transition-colors ${showFilters ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-300'}`}
              >
                <Calendar className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Project Selection Panel - Always visible when filters expanded */}
          {showFilters && (
            <div className="mt-4 space-y-3 animate-in slide-in-from-top-2 duration-200">
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              >
                {Object.keys(folders).sort().reverse().map(year => <option key={year} value={year}>{year}</option>)}
              </select>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              >
                {folders[selectedYear]?.sort((a, b) => parseInt(b) - parseInt(a)).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                type="text"
                placeholder="Search project name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              />
              <select
                value={selectedProject}
                onChange={(e) => handleProjectSelect(e.target.value)}
                disabled={isLoadingProject || filteredProjects.length === 0}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              >
                <option value="">-- Select Project --</option>
                {filteredProjects.sort((a, b) => parseInt(a.code) - parseInt(b.code)).map(p => <option key={p.filename} value={`${p.code} - ${p.name}`}>{p.code} {p.name}</option>)}
              </select>
            </div>
          )}

          {/* Diagnostics Panel */}
          {showDiagnostics && debugData && (
            <div className="mt-4 space-y-3 bg-slate-800 rounded-lg p-3 animate-in slide-in-from-top-2 duration-200 max-h-96 overflow-y-auto">
              <div className="flex items-center justify-between sticky top-0 bg-slate-800 pb-2 border-b border-slate-700">
                <h3 className="text-sm font-semibold text-white">📊 Diagnostics</h3>
                <span className="text-xs text-slate-400">{debugData.totalRows} rows</span>
              </div>
              <div className="text-xs text-slate-400">
                📁 {debugData.source}
              </div>
              <div>
                <span className="text-slate-400 text-xs font-semibold">🔢 All ItemCodes:</span>
                <div className="text-slate-300 text-xs mt-1 flex flex-wrap gap-1">
                  {debugData.uniqueItemCodes?.map((code: string, i: number) => (
                    <span key={i} className="bg-slate-700 px-1.5 py-0.5 rounded">{code}</span>
                  ))}
                </div>
              </div>
              <div>
                <span className="text-slate-400 text-xs font-semibold">🏷️ All DataTypes:</span>
                <div className="text-slate-300 text-xs mt-1 grid grid-cols-1 gap-y-1">
                  {debugData.uniqueDataTypes?.map((dt: string, i: number) => (
                    <div key={i}>• {dt}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Function Guide Panel */}
          {showAcronyms && (
            <div className="mt-4 bg-slate-800 rounded-lg overflow-hidden animate-in slide-in-from-top-2 duration-200">
              {/* Tab Bar */}
              <div className="flex border-b border-slate-700">
                <button
                  onClick={() => setGuideTab('commands')}
                  className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${guideTab === 'commands' ? 'bg-blue-500/20 text-blue-400 border-b-2 border-blue-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                >
                  ⚡ Commands
                </button>
                <button
                  onClick={() => setGuideTab('financial')}
                  className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${guideTab === 'financial' ? 'bg-green-500/20 text-green-400 border-b-2 border-green-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                >
                  💰 Financial Types
                </button>
                <button
                  onClick={() => setGuideTab('data')}
                  className={`flex-1 px-3 py-2 text-xs font-semibold transition-colors ${guideTab === 'data' ? 'bg-purple-500/20 text-purple-400 border-b-2 border-purple-400' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                >
                  📊 Data Types
                </button>
              </div>

              {/* Tab Content */}
              <div className="p-3 max-h-64 overflow-y-auto">
                {guideTab === 'commands' && (
                  <div className="space-y-2 text-xs">
                    <h4 className="text-slate-300 font-semibold mb-2">Available Commands</h4>
                    {[
                      { cmd: 'Analyze', desc: 'Run financial analysis (6 comparisons)' },
                      { cmd: 'Compare X vs Y', desc: 'Compare two financial types' },
                      { cmd: 'Trend [metric] [N]', desc: 'Show values over N months' },
                      { cmd: 'List', desc: 'Show data items (list, list more, list 2.2)' },
                      { cmd: 'Total [item] [type]', desc: 'Sum sub-items under a parent' },
                      { cmd: 'Detail X', desc: 'Drill down into results' },
                      { cmd: 'Risk', desc: 'Risk items across WIP/Committed/CF' },
                      { cmd: 'Cash Flow', desc: 'Last 12 months GP summary' },
                      { cmd: 'Type', desc: 'List all Financial Types & Sheets' },
                      { cmd: 'Shortcuts', desc: 'Full help with all shortcuts' },
                    ].map(({ cmd, desc }) => (
                      <div key={cmd} className="flex items-start gap-2 py-1">
                        <code className="bg-slate-700 text-blue-300 px-1.5 py-0.5 rounded text-[11px] font-mono whitespace-nowrap shrink-0">{cmd}</code>
                        <span className="text-slate-400">{desc}</span>
                      </div>
                    ))}
                    <div className="mt-3 pt-2 border-t border-slate-700">
                      <h4 className="text-slate-300 font-semibold mb-1">💡 Examples</h4>
                      <div className="text-slate-500 space-y-0.5">
                        <div>"<span className="text-slate-300">Show projected gp</span>"</div>
                        <div>"<span className="text-slate-300">compare bp with wip</span>"</div>
                        <div>"<span className="text-slate-300">trend gp 12</span>"</div>
                        <div>"<span className="text-slate-300">total materials projection</span>"</div>
                        <div>"<span className="text-slate-300">risk</span>" → "<span className="text-slate-300">detail 1</span>"</div>
                      </div>
                    </div>
                  </div>
                )}

                {guideTab === 'financial' && (
                  <div className="space-y-1 text-xs">
                    <h4 className="text-slate-300 font-semibold mb-2">Financial Type Shortcuts</h4>
                    {[
                      { shortcuts: 'bp', full: 'Business Plan' },
                      { shortcuts: 'budget, bt', full: 'Latest Budget' },
                      { shortcuts: 'revision, rev', full: 'Latest Budget (same as budget/bt)' },
                      { shortcuts: '1wb', full: '1st Working Budget' },
                      { shortcuts: 'tender', full: 'Budget Tender' },
                      { shortcuts: 'projection, projected', full: 'Projection' },
                      { shortcuts: 'wip, audit', full: 'WIP' },
                      { shortcuts: 'committed', full: 'Committed Cost' },
                      { shortcuts: 'cf, cashflow', full: 'Cash Flow' },
                      { shortcuts: 'accrual', full: 'Accrual' },
                    ].map(({ shortcuts, full }) => (
                      <div key={shortcuts} className="flex items-center gap-2 py-0.5">
                        <code className="bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded text-[11px] font-mono whitespace-nowrap shrink-0">{shortcuts}</code>
                        <span className="text-slate-500">→</span>
                        <span className="text-slate-300">{full}</span>
                      </div>
                    ))
                    }
                    <div className="mt-3 pt-2 border-t border-slate-700 text-slate-500">
                      💡 Use these in queries: "<span className="text-slate-300">Show bp gp</span>" = Business Plan Gross Profit
                    </div>
                  </div>
                )}

                {guideTab === 'data' && (
                  <div className="space-y-1 text-xs">
                    <h4 className="text-slate-300 font-semibold mb-2">Data Type Shortcuts</h4>
                    {[
                      { shortcuts: 'gp', full: 'Gross Profit (Item 3)' },
                      { shortcuts: 'np', full: 'Net Profit/Loss (Item 7)' },
                      { shortcuts: 'cost', full: 'Total Cost (Item 2)' },
                      { shortcuts: 'income, revenue', full: 'Total Income (Item 1)' },
                      { shortcuts: 'prelim', full: 'Preliminaries (Item 2.1)' },
                      { shortcuts: 'materials', full: 'Materials (Item 2.2)' },
                      { shortcuts: 'plant', full: 'Plant & Machinery (Item 2.3)' },
                      { shortcuts: 'subcon, sub, subbie', full: 'Subcontractor (Item 2.4)' },
                      { shortcuts: 'labour', full: 'Direct Labour (Item 2.5)' },
                      { shortcuts: 'rebar', full: 'Reinforcement (Item 2.2.2)' },
                      { shortcuts: 'vo, variation', full: 'Variation Orders' },
                      { shortcuts: 'retention', full: 'Retention' },
                      { shortcuts: 'overhead, oh', full: 'Overheads (Item 6)' },
                    ].map(({ shortcuts, full }) => (
                      <div key={shortcuts} className="flex items-center gap-2 py-0.5">
                        <code className="bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded text-[11px] font-mono whitespace-nowrap shrink-0">{shortcuts}</code>
                        <span className="text-slate-500">→</span>
                        <span className="text-slate-300">{full}</span>
                      </div>
                    ))}
                    <div className="mt-3 pt-2 border-t border-slate-700 text-slate-500">
                      💡 Combine with types: "<span className="text-slate-300">projected subcon</span>" = Projected Subcontractor Cost
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Selected Project Info */}
          {selectedProject && (
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-green-400" />
                <span className="text-green-400 text-sm font-medium">{selectedProject}</span>
                {isLoadingProject && <Loader2 className="w-4 h-4 text-blue-400 animate-spin ml-auto" />}
              </div>
              {metrics && (
                <>
                  {/* Financial Metrics Row */}
                  <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">BP GP</div>
                      <div className="text-green-400 font-bold text-base">{formatSummaryNumber(metrics['Business Plan GP'])}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Proj GP</div>
                      <div className="text-blue-400 font-bold text-base">{formatSummaryNumber(metrics['Projected GP'])}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">WIP</div>
                      <div className="text-purple-400 font-bold text-base">{formatSummaryNumber(metrics['WIP GP'])}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">CF</div>
                      <div className="text-yellow-400 font-bold text-base">{formatSummaryNumber(metrics['Cash Flow'])}</div>
                    </div>
                  </div>
                  {/* Project Info Row */}
                  <div className="mt-2 grid grid-cols-5 gap-2 text-xs">
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Start</div>
                      <div className="text-orange-400 font-medium">{metrics['Start Date']}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Complete</div>
                      <div className="text-orange-400 font-medium">{metrics['Complete Date']}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Target</div>
                      <div className="text-orange-400 font-medium">{metrics['Target Complete Date']}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Time %</div>
                      <div className="text-pink-400 font-medium">{metrics['Time Consumed (%)']}</div>
                    </div>
                    <div className="bg-slate-700/50 rounded px-2 py-1">
                      <div className="text-slate-400">Target %</div>
                      <div className="text-cyan-400 font-medium">{metrics['Target Completed (%)']}</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message, i) => (
            <div key={i} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex gap-2 max-w-[85%] ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${message.role === 'user' ? 'bg-blue-500' : 'bg-green-500'}`}>
                  {message.role === 'user' ? <User className="w-4 h-4 text-white" /> : <Bot className="w-4 h-4 text-white" />}
                </div>
                <div className={`rounded-xl px-3 py-2 ${message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-100'}`}>
                  {message.role === 'assistant' && message.candidates && message.candidates.length > 0 ? (
                    <CandidateMessage content={message.content} candidates={message.candidates} onSelect={handleCandidateSelect} />
                  ) : (
                    <div className="whitespace-pre-wrap text-sm">{boldDollars(message.content)}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {!selectedProject && (
            <div className="text-center py-8">
              <Building2 className="w-10 h-10 text-slate-600 mx-auto mb-2" />
              <p className="text-slate-500 text-sm">Select a project above to begin</p>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-slate-700 bg-slate-800/50">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder={selectedProject ? "Ask about financial data..." : "Select a project first"} className="flex-1 bg-slate-700 border border-slate-600 rounded-xl px-4 py-2 text-white placeholder-slate-500 text-sm" disabled={!selectedProject} />
            <button type="submit" disabled={!input.trim() || !selectedProject} className="bg-blue-500 hover:bg-blue-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-xl px-4 py-2">
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
      </SignedIn>

      <SignedOut>
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white mb-4">Financial Chatbot</h1>
            <SignInButton mode="modal">
              <button className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-6 rounded-lg transition-colors">
                Sign In to Continue
              </button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>
    </main>
  )
}
