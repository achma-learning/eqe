# Anki Auto-Advance Feature

## Introduction
The Anki auto-advance feature allows users to automatically reveal the answer side of a flashcard and/or automatically move to the next card without requiring manual interaction (like clicking a button or pressing a key). This is particularly useful for hands-free reviewing, such as when exercising or during commutes.

## How It Works

The auto-advance functionality in Anki is based on setting specific timers for both the question and answer phases of a card review.

### 1. Configuration
To enable and configure auto-advance, users typically need to set specific time durations within their deck's options:
*   **Seconds to show question:** This timer dictates how long the question side of the card will be displayed before the answer is automatically revealed.
*   **Seconds to show answer:** This timer controls how long the answer side of the card (after it has been revealed) will be displayed before Anki automatically advances to the next card.

These settings are usually found in the "Options" for a specific deck, often accessible via a gear icon next to the deck name in the deck list or within the review screen itself. A non-zero value must be set for these timers for auto-advance to function.

### 2. Activation
Once the timers are configured, auto-advance can typically be activated from the review screen. This might be through a "More" button, a specific menu option (e.g., "Auto Advance"), or a toggle within the study session interface.

### 3. Functionality
When auto-advance is active and configured:
*   **Question Phase:** After the "seconds to show question" timer expires, Anki will automatically reveal the answer side of the current card.
*   **Answer Phase:** After the "seconds to show answer" timer expires, Anki will automatically move to the next card in the review queue.
*   **Automatic Rating (Optional):** Some configurations or add-ons allow for an automatic rating (e.g., "Good") to be applied to the card before advancing, based on the assumption that if the timer expired, the user likely knew the answer sufficiently.
*   **Audio Playback:** If a card includes audio, it will typically play during the respective question or answer phase, integrating with the auto-advance timing.

## Use Cases
*   **Hands-free Review:** Ideal for situations where manual interaction is inconvenient, like during a walk, run, or while driving (with appropriate caution).
*   **Passive Learning:** Allows for a continuous flow of cards, which can be useful for exposure to material, even if not actively recalling.
*   **Specific Learning Strategies:** Some users might find it beneficial for high-volume, rapid reviews where they want to quickly cycle through cards.

## Advanced Features (Add-ons)
The Anki community has developed various add-ons that extend the basic auto-advance functionality, offering more granular control, multiple speed profiles, custom audio behaviors, and other enhancements.
