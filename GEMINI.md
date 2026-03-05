# Project Overview: Multi-Component Development Environment

This directory serves as a development environment for a multi-faceted project. It encompasses both a **JavaScript userscript** designed to enhance the `e-qe.online` web application experience and a **Python toolkit and CLI** for advanced interaction with Gemini Large Language Models (LLMs), including capabilities for tool use and agentic workflows.

## JavaScript Userscript Component: e-qe.online Auto-Advance

This component focuses on improving the user experience on the `e-qe.online` website by providing an "auto-advance" feature, similar to Anki flashcards. It automates progression through questions and answers based on configurable timers, offering a hands-free review experience. The script has been refined to operate reliably within the website's complex and JavaScript-heavy (Next.js/React) page structure.


### Functionality:
The userscript enhances `e-qe.online` with:
*   Configurable question and answer timers.
*   Automatic submission of answers and advancement to the next question.
*   Dynamic Island timer display adapting to light/dark mode and low-time warnings.
*   Audible notifications on timer expiry.
*   Keyboard shortcuts:
    *   `← → ↑ ↓`: Navigate questions.
    *   `Space` / `Enter`: Check/submit answer.
    *   `1-5`: Select answer.
    *   `C`: Toggle Official/Community button.
    *   `A`: Open Explain button.
    *   `Shift + A` / `Shift + P`: Pause/Resume Auto-Advance.
    *   `Shift + S`: Open/Close Settings Panel.
    *   `Shift + ?`: Show Keyboard Shortcuts Help.

### Website Organization:
*   **Main Page**: `https://www.e-qe.online/dashboard`
*   **Course/Module Page**: `https://www.e-qe.online/dashboard/course/*`
*   **Practice/MCQ Page**: `https://www.e-qe.online/lesson/*` (Auto-advance works here)
*   **Exam Page**: `https://www.e-qe.online/exam/*` (Auto-advance works here)

### Installation & Usage:
To use `userscript.txt`, install a userscript manager (e.g., TamperMonkey) in your browser. Create a new script in the manager and paste the content of `userscript.txt`. It will activate automatically on `e-qe.online`.

---

## Python LLM Tools & CLI Component: Gemini Integration

This component provides a Python-based framework for interacting with Google's Gemini Large Language Models, offering advanced capabilities for development, testing, and agentic workflows.

### Key Features:

*   **Gemini Model Interaction (`GeminiModel`, `Gemini` classes):**
    *   Wrappers for making calls to Gemini models (`gemini-2.0-flash-001`, `gemini-1.5-flash`, etc.).
    *   Support for parallel model calls using `ThreadPoolExecutor` with retry logic.
    *   Caching mechanisms (`GenerativeModel.from_cached_content`).
    *   Configuration for model parameters (temperature), safety settings, and API backends (Vertex AI, Gemini API).
    *   Asynchronous content generation with streaming capabilities.

*   **Tool Use and Schema Conversion:**
    *   **`gemini_to_json_schema()` / `_to_gemini_schema()`**: Functions to convert between Gemini `Schema` objects and standard JSON Schema dictionaries, crucial for defining tools that Gemini models can call.
    *   **`from_function_with_options()`**: Dynamically converts Python function signatures (including type hints) into Gemini `FunctionDeclaration` objects, enabling the LLM to understand and utilize custom Python functions as tools.

*   **CLI Framework (`main()` function):**
    *   A command-line interface built with `argparse` for controlling agentic workflows.
    *   Supports arguments for:
        *   `--work-dir`: Working directory for state and files.
        *   `--config`: Configuration file (`config.yaml`).
        *   `--debug`: Enable verbose logging.
        *   `--use-state`: Persist agent state.
        *   `--disable-planning` / `--autonomous-execution` / `--autonomous`: Control agent autonomy levels.
        *   `--task`: Specify initial task input (from string, file, or stdin).
        *   `--llmlog-dir`: Directory for LLM call logs.
        *   `--action-policy`: Define action approval policies.
        *   `--user-proxy-type` / `--metadata-task` / `--metadata-hints` / `--metadata-answer`: Parameters for advanced user proxy simulations.

*   **Graph Database Integration (`query_gremlin()`):**
    *   Functions for executing Gremlin queries against graph database instances (e.g., AWS Neptune), suggesting capabilities for interacting with structured data.

---

**Potential Synergies:**

While currently distinct, these two components could potentially interact. For example, the Python LLM tools could:
*   Analyze quiz data extracted from `e-qe.online` (potentially via programmatic means or data extracted by the userscript).
*   Generate new quiz content or explanations.
*   Or, the userscript could be enhanced to send dynamic content from the `e-qe.online` page to a local Python LLM agent for processing or decision-making.

This project aims to provide versatile tools for both web enhancement and advanced LLM-driven applications.

---

## Maintenance Mandates
After each significant update to `userscript.txt`, you **must**:
1.  **Verify Compliance**: Ensure the script strictly adheres to the Greasy Fork rules outlined in `rules.txt`.
2.  **Update `shortcuts.txt`**: Ensure all keyboard shortcuts and UI controls are accurately reflected.
3.  **Update `changelogs.md`**: Add a new entry following the format: `(Date and Time) - Version (X.X) - [Bullet list of changes]`.
4.  **Sync `showShortcutsHelp`**: If `shortcuts.txt` is updated, you **must** update the `showShortcutsHelp()` function in `userscript.txt` to reflect the changes in the "⌨️" help overlay.

