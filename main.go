package main

import (
	"log"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/egoist/mygo"

	"github.com/dandandujie/grox/internal/model"
	"github.com/dandandujie/grox/internal/service"
)

// AppEvent is the one event stream the page folds into its store.
var AppEvent = mygo.NewEvent[model.Event]("app")

func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "Grox")
}

func main() {
	var winPtr atomic.Pointer[mygo.Window]
	svc, err := service.New(dataDir(), func(ev model.Event) {
		if win := winPtr.Load(); win != nil {
			_ = AppEvent.Emit(win, ev)
		}
	})
	if err != nil {
		log.Fatal(err)
	}
	mygo.BindAs("Grox", svc)

	mygo.App.WhenReady(func() {
		if err := service.Open(svc); err != nil {
			log.Fatal(err)
		}
		service.StartScheduler(svc)
		pageURL := "/"
		if query := os.Getenv("GROX_DEBUG_QUERY"); query != "" {
			pageURL += "?" + query
		}
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "Grox",
			Width:           1440,
			Height:          900,
			MinWidth:        1040,
			MinHeight:       680,
			BackgroundColor: "#0f0f0f",
			StateKey:        "main",
			TitleBarStyle:   mygo.TitleBarHiddenInset,
			TrafficLightPosition: &mygo.Point{
				X: 18,
				Y: 20,
			},
			URL: pageURL,
		})
		winPtr.Store(win)
		win.OnClosed(func() {
			winPtr.Store(nil)
		})
	})
	mygo.App.OnBeforeQuit(func(e *mygo.QuitEvent) {
		service.Close(svc)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
