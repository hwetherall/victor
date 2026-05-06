// Minimal client-only state. TanStack Query owns server data; Zustand only
// holds UI navigation state — which run is selected and which evidence node
// is currently open in the source modal.

import { create } from "zustand";

interface UIState {
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;

  // Source modal: id of the evidence tree_node row whose modal is open.
  openEvidenceNodeId: string | null;
  setOpenEvidenceNodeId: (id: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedRunId: null,
  setSelectedRunId: (id) => set({ selectedRunId: id }),
  openEvidenceNodeId: null,
  setOpenEvidenceNodeId: (id) => set({ openEvidenceNodeId: id }),
}));
