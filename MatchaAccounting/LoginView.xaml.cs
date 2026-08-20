using System;
using System.Windows;
using System.Windows.Input;

namespace MatchaAccounting
{
    public partial class LoginView : Window
    {
        private readonly AuthService _authService;
        public LoginView(ApiClient apiClient)
        {
            InitializeComponent();
            _authService = new AuthService(apiClient);

            // 设置焦点到用户名输入框
            Loaded += (s, e) =>
            {
                txtUsername.Focus();

            };

            // 添加Enter键登录功能
            txtPassword.KeyDown += (s, e) =>
            {
                if (e.Key == Key.Enter)
                {
                    btnLogin_Click(s, e);
                }
            };

            // 用户名框也支持Enter键跳到密码框
            txtUsername.KeyDown += (s, e) =>
            {
                if (e.Key == Key.Enter)
                {
                    txtPassword.Focus();
                }
            };
        }

        private async void btnLogin_Click(object sender, RoutedEventArgs e)
        {
            string username = txtUsername.Text;
            string password = txtPassword.Password;

            lblError.Visibility = Visibility.Collapsed;

            try
            {
                if (await _authService.LoginAsync(username, password))
                {
                    // 登录成功
                    MessageBox.Show("Login successful!", "Success", MessageBoxButton.OK, MessageBoxImage.Information);

                    // 打开主应用程序窗口
                    MainWindow mainWindow = new MainWindow();
                    mainWindow.Show();

                    // 关闭登录窗口
                    Close();
                }
                else
                {
                    // 登录失败
                    lblError.Text = "Invalid username or password.";
                    lblError.Visibility = Visibility.Visible;

                    // 清空密码框
                    txtPassword.Clear();
                    txtPassword.Focus();
                }
            }
            catch (Exception ex)
            {
                lblError.Text = $"Login failed: {ex.Message}";
                lblError.Visibility = Visibility.Visible;
            }
        }

    }
}
