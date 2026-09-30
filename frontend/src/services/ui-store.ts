import { Injectable, signal } from '@angular/core';

// Cross-cutting UI state: the global error banner above the input field.
// Stores and components write to it on failed requests; it is hidden with
// the cross in the banner (InputPanel).
@Injectable({ providedIn: 'root' })
export class UiStore {
  readonly error = signal('');

  setError(message: string): void {
    this.error.set(message);
  }

  dismissError(): void {
    this.error.set('');
  }
}
