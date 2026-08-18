/** One ref update as git reports it on the pre-push hook's stdin. */
export interface PrePushRefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface PrePushInput {
  /**
   * Whether git's ref-update list was successfully read. False means nothing
   * is known about the push — distinct from a list that was read and is empty.
   */
  readable: boolean;
  text: string;
}

export interface PrePushUpdates {
  updates: PrePushRefUpdate[];
  /**
   * Every reported ref update was understood, so a caller enforcing branch
   * policy is deciding on the real set. False for an unreadable input or a
   * malformed line.
   */
  complete: boolean;
}

export declare function parsePrePushUpdates(input: PrePushInput): PrePushUpdates;

/**
 * Read git's ref-update list from the hook's stdin. `readable: false` means
 * the list could not be read at all, which is not the same as an empty one.
 */
export declare function readPrePushInput(): PrePushInput;
