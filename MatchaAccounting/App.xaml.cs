using System;
using System.Windows;

namespace MatchaAccounting
{
    /// <summary>
    /// App.xaml 的交互逻辑
    /// </summary>
    public partial class App : Application
    {
        private void Application_Startup(object sender, StartupEventArgs e)
        {
            SessionManager.Load();

            var apiClient = new ApiClient();
            if (!SessionManager.IsAuthenticated)
            {
                var login = new LoginView(apiClient);
                login.Show();
                return;
            }

            apiClient.SetBearerToken(SessionManager.Current.AccessToken);
            var mainWindow = new MainWindow();
            mainWindow.Show();
        }
    }
}
