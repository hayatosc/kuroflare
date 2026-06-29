export interface DocClockRow {
  readonly latestSeq: number
}

export interface DocSnapshotPointerRow {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | null
}

export interface DocRetentionRow {
  readonly latestSeq: number
  readonly minRetainedSeq: number
  readonly horizonStateVector: ArrayBuffer | null
}

export interface DocIdRow {
  readonly docId: string
}

export interface OpLogUpdateRow {
  readonly updateBytes: ArrayBuffer
}

export interface MessageDedupRow {
  readonly durableSeq: number
}
