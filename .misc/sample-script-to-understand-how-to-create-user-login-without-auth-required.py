import os
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("KRRAJESH_SUPABASE_URL")
SUPABASE_KEY = os.getenv("KRRAJESH_SUPABASE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

DEFAULT_PASSWORD = "Kitab@2024"


def get_all_auth_users():
    """Fetches all users from Supabase Auth with pagination support."""
    all_users = []
    page = 1
    per_page = 100
    while True:
        try:
            users = supabase.auth.admin.list_users(page=page, per_page=per_page)
            if not users:
                break
            all_users.extend(users)
            if len(users) < per_page:
                break
            page += 1
        except Exception as e:
            print(f"Error fetching auth users on page {page}: {e}")
            break
    return all_users


def create_auth_for_existing_profiles():
    print("Fetching existing profiles from DB...")
    profiles = supabase.table("profiles").select("*").execute().data

    if not profiles:
        print("No profiles found.")
        return

    print("Fetching existing auth users...")
    auth_users = get_all_auth_users()
    
    # Map lowercase email -> User object
    auth_map = {}
    for u in auth_users:
        if getattr(u, "email", None):
            auth_map[u.email.lower()] = u

    print(f"\nProcessing {len(profiles)} profiles...")
    
    created_count = 0
    skipped_count = 0
    warning_count = 0
    error_count = 0

    for profile in profiles:
        email = profile["email"]
        full_name = profile["full_name"]
        role = profile["role"]
        old_profile_id = profile["id"]

        if not email:
            print(f"Skipping profile {old_profile_id} (no email)")
            continue

        email_lower = email.lower()

        # Check if user already exists in auth
        if email_lower in auth_map:
            existing_user = auth_map[email_lower]
            if existing_user.id == old_profile_id:
                print(f"ℹ️ {email} already exists in Auth with matching ID ({old_profile_id}). Skipping.")
                skipped_count += 1
            else:
                print(f"⚠️ WARNING: ID mismatch for {email}! Profile ID is {old_profile_id}, but Auth ID is {existing_user.id}.")
                warning_count += 1
            continue

        try:
            print(f"Creating auth user for {email} (id={old_profile_id})...")

            user = supabase.auth.admin.create_user({
                "id": old_profile_id,
                "email": email,
                "password": DEFAULT_PASSWORD,
                "email_confirm": True,
                "user_metadata": {
                    "full_name": full_name,
                    "role": role
                }
            })

            print(f"✅ Auth user created with same ID: {user.user.id}")
            created_count += 1

        except Exception as e:
            print(f"❌ Error creating auth user for {email}: {e}")
            error_count += 1

    print("\n" + "=" * 40)
    print("Sync Summary:")
    print(f"  Profiles Processed: {len(profiles)}")
    print(f"  New Auth Users Created: {created_count}")
    print(f"  Skipped (Already Matched): {skipped_count}")
    print(f"  Warnings (ID Mismatch): {warning_count}")
    print(f"  Errors Encountered: {error_count}")
    print("=" * 40)


if __name__ == "__main__":
    create_auth_for_existing_profiles()