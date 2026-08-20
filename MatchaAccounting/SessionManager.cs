using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.IO;

namespace MatchaAccounting
{
    public static class SessionManager
    {
        private const string SessionFilePath = "session.json";

        public static AuthSession Current { get; private set; }

        public static bool IsAuthenticated => Current != null && Current.ExpiresAtUtc > DateTimeOffset.UtcNow.AddMinutes(1);

        public static void SetSession(AuthSession session)
        {
            Current = session;
            PersistSession();
        }

        public static void Load()
        {
            try
            {
                if (!File.Exists(SessionFilePath))
                {
                    Current = null;
                    return;
                }

                string json = File.ReadAllText(SessionFilePath);
                Current = JsonConvert.DeserializeObject<AuthSession>(json);
            }
            catch
            {
                Current = null;
            }
        }

        public static void Clear()
        {
            Current = null;
            if (File.Exists(SessionFilePath))
            {
                File.Delete(SessionFilePath);
            }
        }

        private static void PersistSession()
        {
            string json = JsonConvert.SerializeObject(Current, Formatting.Indented);
            File.WriteAllText(SessionFilePath, json);
        }
    }
}
