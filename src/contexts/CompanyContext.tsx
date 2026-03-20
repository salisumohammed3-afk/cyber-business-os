import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { Database, CompanyBrief } from '@/integrations/supabase/types'

type CompanyRow = Database['public']['Tables']['companies']['Row']

export interface Company {
  id: string
  name: string
  slug: string
  brief: CompanyBrief
  is_active: boolean
  digest_email: string | null
  digest_enabled: boolean
  created_at: string
}

interface CompanyContextValue {
  company: Company | null
  companies: Company[]
  loading: boolean
  switchCompany: (id: string) => void
  refreshCompanies: () => Promise<void>
}

const CompanyContext = createContext<CompanyContextValue>({
  company: null,
  companies: [],
  loading: true,
  switchCompany: () => {},
  refreshCompanies: async () => {},
})

const STORAGE_KEY = 'sal-os-active-company'

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
  })
  const [loading, setLoading] = useState(true)

  const fetchCompanies = useCallback(async () => {
    const { data } = await supabase
      .from('companies')
      .select('*')
      .eq('is_active', true)
      .order('name')

    if (data) {
      const mapped = (data as CompanyRow[]).map(c => ({
        ...c,
        brief: (c.brief ?? {}) as CompanyBrief,
      }))
      setCompanies(mapped)

      if (mapped.length > 0 && (!activeId || !mapped.find(c => c.id === activeId))) {
        const first = mapped[0].id
        setActiveId(first)
        try { localStorage.setItem(STORAGE_KEY, first) } catch { /* noop */ }
      }
    }
    setLoading(false)
  }, [activeId])

  useEffect(() => { fetchCompanies() }, [fetchCompanies])

  const switchCompany = useCallback((id: string) => {
    setActiveId(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch { /* noop */ }
  }, [])

  const company = companies.find(c => c.id === activeId) ?? null

  return (
    <CompanyContext.Provider value={{ company, companies, loading, switchCompany, refreshCompanies: fetchCompanies }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  return useContext(CompanyContext)
}
