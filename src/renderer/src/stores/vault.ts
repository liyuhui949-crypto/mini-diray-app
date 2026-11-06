import { create } from 'zustand'

import type { JobProgress, VaultSnapshot, VaultStatus } from '@shared/types'

interface VaultState {
  status: 'loading' | VaultStatus
  revision: number
  vaultId: string | null
  busy: JobProgress | null
  lockReason: 'manual' | 'screen-lock' | 'suspend' | 'idle' | 'fatal' | null
  unlockError: string | null
  setStatus: (status: VaultState['status']) => void
  setSnapshot: (snapshot: VaultSnapshot) => void
  setBusy: (progress: JobProgress | null) => void
  setUnlockError: (message: string | null) => void
  setLocked: (reason: VaultState['lockReason']) => void
}

export const useVaultStore = create<VaultState>((set) => ({
  status: 'loading',
  revision: 0,
  vaultId: null,
  busy: null,
  lockReason: null,
  unlockError: null,
  setStatus: (status) => set({ status }),
  setSnapshot: (snapshot) =>
    set({ status: 'unlocked', revision: snapshot.revision, vaultId: snapshot.vaultId }),
  setBusy: (busy) => set({ busy }),
  setUnlockError: (unlockError) => set({ unlockError }),
  setLocked: (lockReason) => set({ status: 'locked', unlockError: null, lockReason, busy: null })
}))
