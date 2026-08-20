using System;
using System.Configuration;

namespace MatchaAccounting
{
    public static class ApiConfig
    {
        public static string ApiBaseUrl
        {
            get
            {
                string raw = GetSetting("ApiBaseUrl", "https://valaxscrub.rf.gd");
                return raw;
            }
        }

        public static int ApiTimeoutSeconds
        {
            get
            {
                return GetIntSetting("ApiTimeoutSeconds", 25);
            }
        }

        public static string GetSetting(string key, string defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            if (string.IsNullOrWhiteSpace(raw))
            {
                return defaultValue;
            }
            return raw;
        }

        public static int GetIntSetting(string key, int defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            int value = 0;
            if (int.TryParse(raw, out value))
            {
                return value;
            }
            return defaultValue;
        }
    }
}
