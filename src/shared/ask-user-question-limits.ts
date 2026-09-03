/**
 * `ask_user_question` free-text limits — one home for two numbers that both
 * sides of the IPC boundary have to agree on.
 *
 * The gate (main) rejects a response that breaks either limit, and the card
 * (renderer) has to stop the user before they type past one: a field that
 * accepts 600 characters and a gate that refuses them leaves the user pressing
 * send against a card that will not close and says nothing about why. The card
 * cannot import the gate — that module reaches for `electron` and `node:crypto`
 * — so the numbers live here, where both can read the same ones.
 */

/** Cap on one typed answer, long enough for a sentence and short of a paste. */
export const MAX_FREE_TEXT_LENGTH = 500;

/** Cap on the free-text field's placeholder — it has one line to sit on. */
export const MAX_PLACEHOLDER_LENGTH = 40;
