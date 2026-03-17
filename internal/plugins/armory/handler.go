// handler.go provides HTTP endpoints for the Armory gallery. Thin handlers
// that bind request parameters, call the Armory service, and render templ
// components or JSON responses.
package armory

import (
	"context"
	"net/http"
	"strconv"

	"github.com/labstack/echo/v4"

	"github.com/keyxmakerx/chronicle/internal/apperror"
	"github.com/keyxmakerx/chronicle/internal/middleware"
	"github.com/keyxmakerx/chronicle/internal/plugins/auth"
	"github.com/keyxmakerx/chronicle/internal/plugins/campaigns"
)

// Handler serves Armory gallery endpoints.
type Handler struct {
	svc ArmoryService
}

// NewHandler creates a new Armory gallery handler.
func NewHandler(svc ArmoryService) *Handler {
	return &Handler{svc: svc}
}

// Index renders the Armory gallery page at GET /campaigns/:id/armory.
// Returns a full page or an HTMX fragment depending on the request header.
func (h *Handler) Index(c echo.Context) error {
	cc := campaigns.GetCampaignContext(c)
	if cc == nil {
		return apperror.NewMissingContext()
	}

	opts := DefaultItemListOptions()
	if p := c.QueryParam("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			opts.Page = n
		}
	}
	if pp := c.QueryParam("per_page"); pp != "" {
		if n, err := strconv.Atoi(pp); err == nil && n > 0 && n <= 100 {
			opts.PerPage = n
		}
	}
	if s := c.QueryParam("sort"); s != "" {
		opts.Sort = s
	}
	if q := c.QueryParam("q"); q != "" {
		opts.Search = q
	}
	if t := c.QueryParam("tag"); t != "" {
		opts.Tag = t
	}
	if tid := c.QueryParam("type"); tid != "" {
		if n, err := strconv.Atoi(tid); err == nil && n > 0 {
			opts.TypeID = n
		}
	}

	userID := auth.GetUserID(c)
	cards, total, err := h.svc.ListItems(c.Request().Context(), cc.Campaign.ID, int(cc.MemberRole), userID, opts)
	if err != nil {
		return apperror.NewInternal(err)
	}

	// Fetch item types for the filter dropdown.
	itemTypes, _ := h.svc.GetItemTypes(c.Request().Context(), cc.Campaign.ID)

	if middleware.IsHTMX(c) {
		return middleware.Render(c, http.StatusOK, ArmoryGalleryContent(cc, cards, total, opts, itemTypes))
	}
	return middleware.Render(c, http.StatusOK, ArmoryGalleryPage(cc, cards, total, opts, itemTypes))
}

// CountAPI returns the item count as JSON at GET /campaigns/:id/armory/count.
// Used by the sidebar badge and layout blocks.
func (h *Handler) CountAPI(c echo.Context) error {
	cc := campaigns.GetCampaignContext(c)
	if cc == nil {
		return apperror.NewMissingContext()
	}

	userID := auth.GetUserID(c)
	count, err := h.svc.CountItems(c.Request().Context(), cc.Campaign.ID, int(cc.MemberRole), userID)
	if err != nil {
		return apperror.NewInternal(err)
	}

	return c.JSON(http.StatusOK, map[string]int{"count": count})
}

// GalleryBlock fetches item cards for embedding in entity page layout blocks.
// Returns a compact card list limited by the block config.
func (h *Handler) GalleryBlock(ctx context.Context, campaignID string, role int, userID string, limit int) ([]ItemCard, error) {
	opts := DefaultItemListOptions()
	opts.PerPage = limit

	cards, _, err := h.svc.ListItems(ctx, campaignID, role, userID, opts)
	return cards, err
}
