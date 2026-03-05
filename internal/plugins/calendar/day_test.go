package calendar

import (
	"testing"
)

func TestDayViewData_MonthName(t *testing.T) {
	cal := &Calendar{
		Months: []Month{
			{Name: "January", Days: 30},
			{Name: "February", Days: 28},
		},
	}
	data := DayViewData{Calendar: cal, MonthIndex: 2}
	if got := data.MonthName(); got != "February" {
		t.Errorf("expected February, got %s", got)
	}
}

func TestDayViewData_IsToday(t *testing.T) {
	cal := &Calendar{
		CurrentYear:  1024,
		CurrentMonth: 3,
		CurrentDay:   15,
	}

	today := DayViewData{Calendar: cal, Year: 1024, MonthIndex: 3, Day: 15}
	if !today.IsToday() {
		t.Error("expected IsToday to be true")
	}

	notToday := DayViewData{Calendar: cal, Year: 1024, MonthIndex: 3, Day: 14}
	if notToday.IsToday() {
		t.Error("expected IsToday to be false")
	}
}

func TestDayViewData_PrevDay(t *testing.T) {
	cal := &Calendar{
		Months: []Month{
			{Name: "January", Days: 30},
			{Name: "February", Days: 28},
		},
	}

	// Normal case: day in the middle of a month.
	data := DayViewData{Calendar: cal, Year: 1, MonthIndex: 1, Day: 15}
	y, m, d := data.PrevDay()
	if y != 1 || m != 1 || d != 14 {
		t.Errorf("expected 1/1/14, got %d/%d/%d", y, m, d)
	}

	// Cross-month boundary: first day of February goes to January.
	data = DayViewData{Calendar: cal, Year: 1, MonthIndex: 2, Day: 1}
	y, m, d = data.PrevDay()
	if y != 1 || m != 1 || d != 30 {
		t.Errorf("expected 1/1/30, got %d/%d/%d", y, m, d)
	}

	// Cross-year boundary: first day of January goes to last month of prev year.
	data = DayViewData{Calendar: cal, Year: 2, MonthIndex: 1, Day: 1}
	y, m, d = data.PrevDay()
	if y != 1 || m != 2 || d != 28 {
		t.Errorf("expected 1/2/28, got %d/%d/%d", y, m, d)
	}
}

func TestDayViewData_NextDay(t *testing.T) {
	cal := &Calendar{
		Months: []Month{
			{Name: "January", Days: 30},
			{Name: "February", Days: 28},
		},
	}

	// Normal case.
	data := DayViewData{Calendar: cal, Year: 1, MonthIndex: 1, Day: 15}
	y, m, d := data.NextDay()
	if y != 1 || m != 1 || d != 16 {
		t.Errorf("expected 1/1/16, got %d/%d/%d", y, m, d)
	}

	// Cross-month: last day of January goes to February 1.
	data = DayViewData{Calendar: cal, Year: 1, MonthIndex: 1, Day: 30}
	y, m, d = data.NextDay()
	if y != 1 || m != 2 || d != 1 {
		t.Errorf("expected 1/2/1, got %d/%d/%d", y, m, d)
	}

	// Cross-year: last day of last month goes to year+1 month 1.
	data = DayViewData{Calendar: cal, Year: 1, MonthIndex: 2, Day: 28}
	y, m, d = data.NextDay()
	if y != 2 || m != 1 || d != 1 {
		t.Errorf("expected 2/1/1, got %d/%d/%d", y, m, d)
	}
}

func TestDayViewData_WeekdayName(t *testing.T) {
	cal := &Calendar{
		Months: []Month{
			{Name: "January", Days: 30},
		},
		Weekdays: []Weekday{
			{Name: "Mon"}, {Name: "Tue"}, {Name: "Wed"},
			{Name: "Thu"}, {Name: "Fri"}, {Name: "Sat"}, {Name: "Sun"},
		},
	}

	data := DayViewData{Calendar: cal, Year: 1, MonthIndex: 1, Day: 1}
	name := data.WeekdayName()
	if name == "" {
		t.Error("expected a weekday name, got empty string")
	}
	// Verify it's one of the defined weekday names.
	validNames := map[string]bool{"Mon": true, "Tue": true, "Wed": true, "Thu": true, "Fri": true, "Sat": true, "Sun": true}
	if !validNames[name] {
		t.Errorf("unexpected weekday name: %s", name)
	}
}
