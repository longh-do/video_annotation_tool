/** Shapes of the HTTP API, shared by the server and the browser. */
import type { AnnotationFile, Sidecar, SidecarDraft, Status } from './annotation.ts';

export interface Session {
  readonly annotatorId: string;
  readonly toolVersion: string;
  readonly guideline: { readonly title: string; readonly version: string } | null;
}

export interface QueueItem {
  readonly id: string;
  readonly durationS: number;
  readonly status: Status;
  readonly keepIntervals: number;
  readonly savedAt: string | null;
}

export interface QueueResponse {
  readonly session: Session;
  readonly recordings: readonly QueueItem[];
}

export interface CameraInfo {
  readonly name: string;
  readonly label: string;
  /** Manifest-relative path; the reference camera's is the contract's `reference_video`. */
  readonly video: string;
  readonly videoUrl: string;
  readonly framesUrl: string;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
}

export interface ThumbnailInfo {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly sheetUrls: readonly string[];
  /** The reference frame each thumbnail shows, in sheet order. */
  readonly frames: readonly number[];
}

export interface RecordingResponse {
  readonly id: string;
  readonly durationS: number;
  /** The reference camera (the one annotated) first. */
  readonly cameras: readonly CameraInfo[];
  readonly thumbnails: ThumbnailInfo | null;
}

export interface SavedAnnotation {
  /** The revision to name in If-Match when saving on top of this one. */
  readonly revision: number;
  readonly annotation: AnnotationFile;
  /** Null for a contract file written by something else (e.g. a gold file). */
  readonly sidecar: Sidecar | null;
}

export interface SavePayload {
  readonly annotation: AnnotationFile;
  readonly sidecar: SidecarDraft;
}

export interface SaveResult {
  readonly revision: number;
  readonly savedAt: string;
}

export interface ErrorBody {
  readonly error?: string;
  readonly problems?: readonly string[];
  /** On 412: the revision the server has. */
  readonly revision?: number;
}
