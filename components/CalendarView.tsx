import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Circle } from 'lucide-react';
import { Note } from '../types';

interface CalendarViewProps {
  notes: Note[];
  onSelectDate: (date: Date) => void;
  isDarkMode?: boolean;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ notes, onSelectDate, isDarkMode = true }) => {
  const [currentDate, setCurrentDate] = useState(new Date());

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();

  // Create array of days for grid
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const paddingDays = Array.from({ length: firstDayOfMonth }, (_, i) => null);

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const hasNoteOnDay = (day: number) => {
    return notes.some(note => {
      const noteDate = new Date(note.createdAt);
      return (
        noteDate.getDate() === day &&
        noteDate.getMonth() === month &&
        noteDate.getFullYear() === year
      );
    });
  };

  // Get note counts or types for a specific day to show indicators
  const getDayInfo = (day: number) => {
    const dayNotes = notes.filter(note => {
      const noteDate = new Date(note.createdAt);
      return (
        noteDate.getDate() === day &&
        noteDate.getMonth() === month &&
        noteDate.getFullYear() === year
      );
    });
    return { hasNotes: dayNotes.length > 0, count: dayNotes.length };
  };

  return (
    <div className={`w-full h-full flex flex-col p-6 pt-12 transition-colors duration-500 ${isDarkMode ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h2 className={`text-2xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-zinc-900'}`}>
          {currentDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
        <div className="flex gap-2">
          <button onClick={prevMonth} className={`p-2 rounded-full transition-colors ${isDarkMode ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-zinc-200 text-zinc-500 hover:text-zinc-900'}`}>
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button onClick={nextMonth} className={`p-2 rounded-full transition-colors ${isDarkMode ? 'hover:bg-zinc-800 text-zinc-400 hover:text-white' : 'hover:bg-zinc-200 text-zinc-500 hover:text-zinc-900'}`}>
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Weekday Headers */}
      <div className="grid grid-cols-7 mb-4">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className={`text-center text-xs font-bold uppercase tracking-widest ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {day}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-y-4 gap-x-2 flex-1 auto-rows-min">
        {paddingDays.map((_, i) => (
          <div key={`padding-${i}`} />
        ))}
        {days.map(day => {
          const info = getDayInfo(day);
          const isToday = 
            day === new Date().getDate() && 
            month === new Date().getMonth() && 
            year === new Date().getFullYear();

          return (
            <button
              key={day}
              onClick={() => onSelectDate(new Date(year, month, day))}
              className={`
                aspect-square relative rounded-2xl flex flex-col items-center justify-center transition-all
                ${isToday 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/50' 
                    : (isDarkMode ? 'hover:bg-zinc-900 text-zinc-300' : 'hover:bg-zinc-200 text-zinc-700')
                }
              `}
            >
              <span className={`text-lg font-medium ${isToday ? 'font-bold' : ''}`}>{day}</span>
              
              {/* Note Indicator Dots */}
              <div className="flex gap-0.5 mt-1 h-1.5">
                 {info.hasNotes && (
                   <div className={`w-1.5 h-1.5 rounded-full ${isToday ? 'bg-white/70' : 'bg-emerald-500'}`} />
                 )}
              </div>
            </button>
          );
        })}
      </div>
      
      <div className={`mt-auto text-center text-sm pb-8 ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>
         Select a date to jump to the timeline
      </div>
    </div>
  );
};