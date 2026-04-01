import React, { useState } from 'react';
import { Plus, ShieldCheck, X } from 'lucide-react';

export default function CommissionModal({ onClose, onCommission }) {
  const [formData, setFormData] = useState({ id: 'RBT-1000', type: 'Rover', zone: 'Sector 1A' });

  const handleSubmit = (e) => {
    e.preventDefault();
    onCommission(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200">
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <div className="flex items-center gap-2 text-slate-900">
            <Plus className="w-5 h-5 text-blue-600" />
            <h2 className="font-bold tracking-wide text-lg">Commission New Unit</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Unit Identifier</label>
            <input
              type="text"
              value={formData.id}
              onChange={(e) => setFormData({ ...formData, id: e.target.value })}
              className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2.5 font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              placeholder="RBT-1234"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Chassis Type</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option>Rover (Ground)</option>
              <option>Drone (Aerial)</option>
              <option>Bipedal (Indoor)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Initial Assignment Zone</label>
            <select
              value={formData.zone}
              onChange={(e) => setFormData({ ...formData, zone: e.target.value })}
              className="w-full bg-white border border-slate-300 rounded-lg px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option>Sector 1A (Logistics)</option>
              <option>Sector 7G (Assembly)</option>
              <option>Perimeter Patrol</option>
            </select>
          </div>

          <div className="pt-4 border-t border-slate-100 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-bold transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-2 bg-slate-900 hover:bg-slate-800 text-white py-2.5 rounded-lg text-sm font-bold transition-colors shadow-sm flex items-center justify-center gap-2"
            >
              <ShieldCheck className="w-4 h-4" /> Authorize Commissioning
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
