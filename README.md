# TABMAX
A clean mind starts with clean tabs.

Managing dozens of important tabs shouldn’t feel like navigating a jungle. TABMAX is an open-source Chrome extension that lets you effortlessly organize Tabs → Sessions → Folders — all neatly structured, synced, restorable, and blazing fast.

And yes… it will always remain 100% open-source and free. 🎉

## Why TABMAX?
Because you shouldn't have to:
- Keep Chrome running for weeks
- Avoid shutting down your laptop
- Lose tabs accidentally
- Pay $10–$20/month for a proprietary tab manager
- Get tracked, profiled, or data-mined by extensions

TABMAX helps you store, group, restore, and revisit your workflow — without spying on you, without subscriptions, without lock-ins.

Organize once. Continue forever.

## How to install
TABMAX will be on the Chrome Web Store once it becomes fully stable.
Until then, you can load it manually:
1. Clone this repository
    ```git clone <repository-url>```
2. Move into the project directory
    ```cd tabmax```
3. Install dependencies
    ```npm install```
4. Build the extension
    ```npm run build```
5. Open Chrome → Extensions → Enable Developer Mode
6. Click Load Unpacked and select the tabmax folder 
You're good to go!

## How TABMAX Organizes Your Tabs
TABMAX uses a simple but powerful hierarchy
```
Folder
 └── Session
      └── Tabs
```
### ✔ Folder-Level Organization
Group your projects, hobbies, or categories.

### ✔ Session-Level Organization
Store full sets of tabs for specific activities.

### ✔ Tab-Level Management
Every session can track multiple tabs seamlessly.

## Real-World Example (Max & Lewis)
Max is a curious nerd with 60+ tabs open.
He never shuts his laptop because—if he does—his tab universe collapses.

Lewis, also a nerd, pays $20/month for a tab manager… but it collects data and sends him promo emails based on how he browses.

Max wants Lewis’s organization, without the tracking.

He finds TABMAX, saves his sessions into folders, closes Chrome confidently, reopens it later, and everything is exactly where he left it — private, organized, and free.

### Practical example structure:
```
work/
   sessions/
      my_job/
         tabs/
            [list of tabs]
      open_source_dev/
         tabs/
            [list of tabs]

study/
   sessions/
      rocket_science/
         tabs/
            [list of tabs]
      startup_founders/
         tabs/
            [list of tabs]

fun/
   sessions/
      f1/
         tabs/
            [list of tabs]
      chelsea/
         tabs/
            [list of tabs]
```

so tabmax keeps or tab organised and restored(you can now shut down your pc savely) all for free!
    
### Want to Contribute?

All contributions are welcome — bug fixes, performance improvements, UI enhancements, documentation, and feature suggestions.

If you break something (yes, please do!), open an issue describing:

- what broke

- how to reproduce it

- what you think caused it

Then feel free to open a PR with a fix!
Help us make TABMAX the best open-source tab manager ever.

### ❤️ Built For the Community

TABMAX is and will always remain open-source, privacy-respecting, and free.
Let’s build something the Chrome ecosystem deserves