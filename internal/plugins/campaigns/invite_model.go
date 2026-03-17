package campaigns

import "time"

// Invite represents a pending invitation for a user to join a campaign.
type Invite struct {
	ID         string     `json:"id"`
	CampaignID string     `json:"campaign_id"`
	Email      string     `json:"email"`
	Role       string     `json:"role"`
	Token      string     `json:"-"` // Never exposed in JSON.
	CreatedBy  string     `json:"created_by"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	AcceptedAt *time.Time `json:"accepted_at,omitempty"`

	// Joined from users table for display.
	CreatedByName string `json:"created_by_name,omitempty"`
}

// IsExpired returns true if the invite has passed its expiry time.
func (i *Invite) IsExpired() bool {
	return time.Now().UTC().After(i.ExpiresAt)
}

// IsPending returns true if the invite has not been accepted or expired.
func (i *Invite) IsPending() bool {
	return i.AcceptedAt == nil && !i.IsExpired()
}

// CreateInviteInput holds the data needed to create a new campaign invite.
type CreateInviteInput struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// inviteTokenBytes is the number of random bytes in an invite token.
const inviteTokenBytes = 32

// inviteExpiryDays is how long an invite link stays valid.
const inviteExpiryDays = 7
