import React, { useState } from 'react';
import { Github, Copy, Check, Terminal, Download, ExternalLink, X, FileCode } from 'lucide-react';

interface GitHubDeployModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const GitHubDeployModal: React.FC<GitHubDeployModalProps> = ({ isOpen, onClose }) => {
  const [copiedWorkflow, setCopiedWorkflow] = useState(false);
  const [copiedCommands, setCopiedCommands] = useState(false);
  const [repoName, setRepoName] = useState('neon-air-hockey-3d');
  const [githubUser, setGithubUser] = useState('your-username');

  if (!isOpen) return null;

  const workflowYml = `name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Dependencies
        run: npm ci

      - name: Build Project
        run: npm run build

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
`;

  const gitCommands = `# 1. Initialize git in your project
git init

# 2. Add all project files
git add .

# 3. Commit changes
git commit -m "Initial commit: Neon Air Hockey 3D"

# 4. Set main branch
git branch -M main

# 5. Link your GitHub repository
git remote add origin https://github.com/${githubUser}/${repoName}.git

# 6. Push to GitHub
git push -u origin main`;

  const handleCopyWorkflow = () => {
    navigator.clipboard.writeText(workflowYml);
    setCopiedWorkflow(true);
    setTimeout(() => setCopiedWorkflow(false), 2000);
  };

  const handleCopyCommands = () => {
    navigator.clipboard.writeText(gitCommands);
    setCopiedCommands(true);
    setTimeout(() => setCopiedCommands(false), 2000);
  };

  const handleDownloadZip = () => {
    // Generate a simulated project export notification or instruction
    alert("To download your full project for GitHub, use your IDE workspace export or clone this repository from your AI Studio project repository manager!");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl bg-slate-900 border border-cyan-500/40 shadow-2xl shadow-cyan-950/80 flex flex-col p-6 text-slate-100">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Github className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-cyan-300 font-mono">GitHub Deployment & Setup</h2>
              <p className="text-xs text-slate-400">Push your Neon Air Hockey game to GitHub and deploy to GitHub Pages</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-300 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="py-4 flex flex-col gap-5 text-xs">
          
          {/* Step 1: Repo Configuration */}
          <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
            <span className="font-bold text-cyan-400 uppercase tracking-wider font-mono">1. Configure Repository Names</span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
              <div>
                <label className="text-slate-400 block mb-1">GitHub Username / Org:</label>
                <input
                  type="text"
                  value={githubUser}
                  onChange={e => setGithubUser(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-cyan-300 font-mono outline-none focus:border-cyan-500"
                  placeholder="e.g. johndoe"
                />
              </div>
              <div>
                <label className="text-slate-400 block mb-1">Repository Name:</label>
                <input
                  type="text"
                  value={repoName}
                  onChange={e => setRepoName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-cyan-300 font-mono outline-none focus:border-cyan-500"
                  placeholder="e.g. neon-air-hockey"
                />
              </div>
            </div>
          </div>

          {/* Step 2: Git Commands */}
          <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
            <div className="flex items-center justify-between">
              <span className="font-bold text-cyan-400 uppercase tracking-wider font-mono flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                2. Initialize & Push to GitHub
              </span>
              <button
                onClick={handleCopyCommands}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/30 transition font-mono"
              >
                {copiedCommands ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCommands ? 'Copied!' : 'Copy Commands'}</span>
              </button>
            </div>
            <pre className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto leading-relaxed">
              {gitCommands}
            </pre>
          </div>

          {/* Step 3: GitHub Actions Workflow */}
          <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-slate-950 border border-slate-800">
            <div className="flex items-center justify-between">
              <span className="font-bold text-cyan-400 uppercase tracking-wider font-mono flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                3. GitHub Actions Auto-Deploy (.github/workflows/deploy.yml)
              </span>
              <button
                onClick={handleCopyWorkflow}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/30 transition font-mono"
              >
                {copiedWorkflow ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedWorkflow ? 'Copied!' : 'Copy Workflow'}</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Save this file as <code className="text-cyan-300 font-mono">.github/workflows/deploy.yml</code> in your repository root to automatically build and deploy on every push to <code className="text-cyan-300 font-mono">main</code>.
            </p>
            <pre className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-300 overflow-x-auto max-h-48 leading-relaxed">
              {workflowYml}
            </pre>
          </div>

          {/* Step 4: Vite Base Path note */}
          <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-start gap-2.5 text-slate-300 text-xs">
            <ExternalLink className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-cyan-300">GitHub Pages Base Path Note:</span> If you are deploying to <code className="font-mono text-cyan-400">https://{githubUser}.github.io/{repoName}/</code>, ensure your <code className="font-mono text-cyan-400">vite.config.ts</code> includes <code className="font-mono text-cyan-400">base: '/{repoName}/'</code>.
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-slate-800">
          <span className="text-[11px] text-slate-500 font-mono">Ready to share your Neon Air Hockey game with the world!</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
            >
              Close
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
