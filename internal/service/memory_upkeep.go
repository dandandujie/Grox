package service

import "time"

// runMemoryUpkeep archives over-budget MEMORY.md files for bots that opted in.
// It runs at most once an hour and is intentionally outside the request path.
func (s *Service) runMemoryUpkeep() {
	s.mu.Lock()
	if !s.lastMemoryUpkeep.IsZero() && time.Since(s.lastMemoryUpkeep) < time.Hour {
		s.mu.Unlock()
		return
	}
	s.lastMemoryUpkeep = time.Now()
	ids := make([]string, 0)
	for _, bot := range s.st.State.Bots {
		if bot.MemoryAutoTidy {
			ids = append(ids, bot.ID)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		_, _ = s.TidyMemory(id)
	}
}
