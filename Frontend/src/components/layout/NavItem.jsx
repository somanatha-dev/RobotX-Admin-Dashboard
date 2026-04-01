import React from 'react';

export default function NavItem({ icon, label, active, onClick, badge }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors group relative ${
        active
          ? 'bg-emerald-600 text-white shadow-sm'
          : 'text-slate-300 hover:bg-slate-900/40 hover:text-white'
      }`}
    >
      <div className={`${active ? 'text-white' : 'text-slate-400 group-hover:text-slate-200 transition-colors'}`}>
        {icon}
      </div>
      <span className="font-semibold text-sm">{label}</span>
      {badge > 0 && (
        <div className="absolute right-4 top-1/2 -translate-y-1/2 bg-rose-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm">
          {badge}
        </div>
      )}
    </button>
  );
}
