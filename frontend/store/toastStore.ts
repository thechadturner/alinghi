import { createSignal } from "solid-js";

interface ToastAction {
  label: string;
  onClick: () => void;
  style?: string;
}

interface ToastMessage {
  id: string;
  type: 'script' | 'upload' | 'info' | 'success' | 'warning' | 'error';
  message: string;
  details?: string;
  timestamp: number;
  actions?: ToastAction[];
}

class ToastStore {
  private toasts = createSignal<ToastMessage[]>([]);
  private listeners = new Set<() => void>();

  get toastsList() {
    return this.toasts[0]();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(listener => listener());
  }

  showToast(type: ToastMessage['type'], message: string, details?: string, actions?: ToastAction[]) {
    const id = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const toast: ToastMessage = {
      id,
      type,
      message,
      details,
      timestamp: Date.now(),
      actions
    };

    const [, setToasts] = this.toasts;
    setToasts(prev => [...prev, toast]);
    this.notify();

    // Auto-remove after 5 seconds for script toasts
    if (type === 'script') {
      setTimeout(() => {
        this.removeToast(id);
      }, 5000);
    }

    return id;
  }

  removeToast(id: string) {
    const [, setToasts] = this.toasts;
    setToasts(prev => prev.filter(toast => toast.id !== id));
    this.notify();
  }

  clearAll() {
    const [, setToasts] = this.toasts;
    setToasts([]);
    this.notify();
  }
}

export const toastStore = new ToastStore();
