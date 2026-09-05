const fs = require('fs');
let content = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');

// Update props interface
content = content.replace('onCloseMobile?: () => void;\n}', 'onCloseMobile?: () => void;\n  currentUser?: any;\n  onLogin?: () => void;\n  onLogout?: () => void;\n}');
content = content.replace('onCloseMobile,\n}) => {', 'onCloseMobile,\n  currentUser,\n  onLogin,\n  onLogout,\n}) => {');

const loginUI = `
          {currentUser ? (
            <div className="pt-2 mt-2 border-t border-slate-800/60 flex items-center justify-between px-1">
              <div className="flex items-center space-x-2.5 min-w-0">
                <img src={currentUser.photoURL || ""} alt="" className="w-8 h-8 rounded-full bg-slate-700" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-100 truncate">{currentUser.displayName}</div>
                  <div className="text-[11px] text-slate-400 truncate cursor-pointer hover:text-white" onClick={onLogout}>Sign Out</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="pt-2 mt-2 border-t border-slate-800/60">
              <button onClick={onLogin} className="w-full flex items-center justify-center space-x-2 bg-white text-slate-900 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors">
                <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#EA4335" d="M12.24 10.28L10.56 12l5.44 5.44c-1.36 1.12-3.12 1.76-5 1.76-4.08 0-7.52-2.96-8.56-6.88l-1.92 1.44C2.32 18.56 6.72 22 11 22c3.12 0 5.84-1.04 7.92-2.88l-6.68-8.84z"/><path fill="#4285F4" d="M22.56 12.24c0-.72-.08-1.44-.24-2.16H11v4.08h6.56c-.32 1.6-1.28 2.96-2.56 3.84l6.68 8.84c1.12-2.16 1.84-4.72 1.84-7.52z"/><path fill="#FBBC05" d="M6.24 15.36c-.24-.72-.4-1.52-.4-2.32s.16-1.6.4-2.32L4.32 9.28c-.8 1.6-1.28 3.44-1.28 5.36s.48 3.76 1.28 5.36l1.92-1.44z"/><path fill="#34A853" d="M11 5.04c1.76 0 3.28.64 4.48 1.76l3.36-3.36C16.88 1.36 14.16.24 11 .24 6.72.24 2.32 3.68.48 8.16l1.92 1.44C3.44 6.08 6.88 5.04 11 5.04z"/></svg>
                <span>Sign in with Google</span>
              </button>
            </div>
          )}
`;

content = content.replace(/<div className="pt-2 mt-2 border-t border-slate-800\/60 flex items-center justify-between px-1">[\s\S]*?<\/div>\s*<\/div>\s*<\/aside>/, loginUI + '        </div>\n      </aside>');

fs.writeFileSync('src/components/Sidebar.tsx', content);
console.log("Sidebar updated");
