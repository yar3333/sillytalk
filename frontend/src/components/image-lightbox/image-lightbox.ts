import { Component, inject } from '@angular/core';
import { ImageStore } from '../../services/image-store';

// The lightbox: shows a chat image enlarged, full-width, with a dark backdrop
// and a close button. Opened when the user clicks an image in the chat
// (ImageStore.lightbox carries the media URL). The image keeps the same
// block/contain layout as in the messages, just larger.
@Component({
  selector: 'app-image-lightbox',
  template: `
    @if (imageStore.lightbox(); as url) {
      <div class="lightbox-backdrop" data-testid="lightbox" (click)="imageStore.closeLightbox()">
        <div class="lightbox" (click)="$event.stopPropagation()">
          <button
            class="lightbox-close"
            data-testid="lightbox-close"
            (click)="imageStore.closeLightbox()"
            title="Close"
          >
            ✕
          </button>
          <img class="lightbox-img" [src]="url" alt="" />
        </div>
      </div>
    }
  `,
  styleUrl: './image-lightbox.scss',
})
export class ImageLightbox {
  readonly imageStore = inject(ImageStore);
}
