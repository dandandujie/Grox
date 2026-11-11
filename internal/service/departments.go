package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/dandandujie/grox/internal/model"
)

func (s *Service) ensureDepartmentLocked(name string, now time.Time) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	for _, department := range s.st.State.Departments {
		if strings.EqualFold(department.Name, name) {
			return
		}
	}
	s.st.State.Departments = append(s.st.State.Departments, model.Department{
		ID: newID("dept"), Name: name, CreatedAt: now, UpdatedAt: now,
	})
}

// ListDepartments returns shelves with their current bot counts.
func (s *Service) ListDepartments() []model.Department {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := map[string]int{}
	for _, bot := range s.st.State.Bots {
		counts[strings.ToLower(strings.TrimSpace(bot.Department))]++
	}
	out := make([]model.Department, len(s.st.State.Departments))
	copy(out, s.st.State.Departments)
	for index := range out {
		out[index].BotCount = counts[strings.ToLower(strings.TrimSpace(out[index].Name))]
	}
	return out
}

func (s *Service) CreateDepartment(name string) (model.Department, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.Department{}, fmt.Errorf("give the department a name")
	}
	if len(name) > 60 {
		return model.Department{}, fmt.Errorf("department name is too long")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, department := range s.st.State.Departments {
		if strings.EqualFold(department.Name, name) {
			return model.Department{}, fmt.Errorf("that department already exists")
		}
	}
	now := time.Now()
	department := model.Department{ID: newID("dept"), Name: name, CreatedAt: now, UpdatedAt: now}
	s.st.State.Departments = append(s.st.State.Departments, department)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return department, nil
}

func (s *Service) RenameDepartment(id, name string) (model.Department, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.Department{}, fmt.Errorf("give the department a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var department *model.Department
	for index := range s.st.State.Departments {
		if s.st.State.Departments[index].ID == id {
			department = &s.st.State.Departments[index]
			break
		}
	}
	if department == nil {
		return model.Department{}, fmt.Errorf("department not found")
	}
	if strings.EqualFold(department.Name, "General") && !strings.EqualFold(name, "General") {
		return model.Department{}, fmt.Errorf("General cannot be renamed")
	}
	for _, other := range s.st.State.Departments {
		if other.ID != id && strings.EqualFold(other.Name, name) {
			return model.Department{}, fmt.Errorf("that department already exists")
		}
	}
	old := department.Name
	department.Name = name
	department.UpdatedAt = time.Now()
	for index := range s.st.State.Bots {
		if strings.EqualFold(s.st.State.Bots[index].Department, old) {
			s.st.State.Bots[index].Department = name
			s.st.State.Bots[index].UpdatedAt = time.Now()
		}
	}
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return *department, nil
}

func (s *Service) DeleteDepartment(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	index := -1
	for position := range s.st.State.Departments {
		if s.st.State.Departments[position].ID == id {
			index = position
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("department not found")
	}
	department := s.st.State.Departments[index]
	if strings.EqualFold(department.Name, "General") {
		return fmt.Errorf("General cannot be deleted")
	}
	for position := range s.st.State.Bots {
		if strings.EqualFold(s.st.State.Bots[position].Department, department.Name) {
			s.st.State.Bots[position].Department = "General"
			s.st.State.Bots[position].UpdatedAt = time.Now()
		}
	}
	s.st.State.Departments = append(s.st.State.Departments[:index], s.st.State.Departments[index+1:]...)
	s.touchLocked()
	s.saveLocked()
	s.emitStateLocked()
	return nil
}
